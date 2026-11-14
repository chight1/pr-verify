"""What a lockfile installs, read with the standard library: the exact versions
it takes from a public registry, and the packages it takes from git or a URL
instead. Packages from a local path or a private registry are left out.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from dependency_manifests import normalized

if TYPE_CHECKING:
    from collections.abc import Callable

# A package name and the exact version installed.
Locked = tuple[str, str]

NPM_TARBALL = re.compile(
    r"^https://registry\.(?:npmjs\.org|yarnpkg\.com)/((?:@[^/]+/)?([^/]+))/-/\2-([^/#?]+)\.tgz"
)
YARN_RESOLVED = re.compile(r'^\s+resolved "([^"]+)"')
YARN_RESOLUTION = re.compile(r'^\s+resolution: "((?:@[^@"/]+/)?[^@"]+)@npm:([^"]+)"')
PNPM_PACKAGE = re.compile(r"^  '?/?((?:@[^/@\s']+/)?[^@\s'/]+)@(\d[^\s'():]*)")
REQUIREMENT_PIN = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;\\]+)"
)
PYPI_INDEX = "https://pypi.org/simple"
# Sources that fetch a package from git. Yarn 2 and later write a git source as a
# URL ending in #commit=, checked for separately.
GIT_SOURCES = ("git+", "git://", "github:", "https://codeload.github.com/")
PNPM_GIT_PACKAGE = re.compile(
    r"^  '?((?:@[^/@\s']+/)?[^@\s'/]+)@((?:git\+|github:|https://codeload\.github\.com/)\S+?)'?:$"
)
YARN_RESOLUTION_SOURCE = re.compile(r'^\s+resolution: "((?:@[^@"/]+/)?[^@"]+)@([^"]+)"')
# A go.sum line is a module, a version and a hash.
GO_SUM_FIELDS = 3


def npm_tarball(url: str) -> Locked | None:
    """The package and version of a tarball URL on the npm registry."""
    match = NPM_TARBALL.match(url)
    if match is None:
        return None
    return (match.group(1), match.group(3))


def package_lock_versions(text: str) -> set[Locked]:
    """package-lock.json records the tarball each package was installed from."""
    packages: dict[str, dict[str, Any]] = json.loads(text).get("packages", {})
    versions: set[Locked] = set()
    for entry in packages.values():
        locked = npm_tarball(str(entry.get("resolved", "")))
        if locked is not None:
            versions.add(locked)
    return versions


def pnpm_package_lines(text: str) -> list[str]:
    """The lines of pnpm-lock.yaml's packages section. An unindented line starts
    a section."""
    lines: list[str] = []
    in_packages = False
    for line in text.splitlines():
        if line and not line.startswith(" "):
            in_packages = line.rstrip() == "packages:"
        elif in_packages:
            lines.append(line)
    return lines


def pnpm_versions(text: str) -> set[Locked]:
    """The keys of the packages section, such as left-pad@1.3.0. A key whose version
    does not start with a digit points at a URL, a path or a git commit."""
    versions: set[Locked] = set()
    for line in pnpm_package_lines(text):
        match = PNPM_PACKAGE.match(line)
        if match is not None:
            versions.add((match.group(1), match.group(2)))
    return versions


def yarn_entry(line: str) -> Locked | None:
    """Yarn 1 records a tarball URL, and later versions a name@npm:version."""
    resolved = YARN_RESOLVED.match(line)
    if resolved is not None:
        return npm_tarball(resolved.group(1))
    resolution = YARN_RESOLUTION.match(line)
    if resolution is not None:
        return (resolution.group(1), resolution.group(2))
    return None


def yarn_versions(text: str) -> set[Locked]:
    versions: set[Locked] = set()
    for line in text.splitlines():
        locked = yarn_entry(line)
        if locked is not None:
            versions.add(locked)
    return versions


def uv_versions(text: str) -> set[Locked]:
    """uv records the index each package came from."""
    packages: list[dict[str, Any]] = tomllib.loads(text).get("package", [])
    versions: set[Locked] = set()
    for package in packages:
        if package.get("source", {}).get("registry") == PYPI_INDEX:
            versions.add((normalized(package["name"]), package["version"]))
    return versions


def poetry_versions(text: str) -> set[Locked]:
    """Poetry records a source only for a package that does not come from PyPI."""
    packages: list[dict[str, Any]] = tomllib.loads(text).get("package", [])
    versions: set[Locked] = set()
    for package in packages:
        if "source" not in package:
            versions.add((normalized(package["name"]), package["version"]))
    return versions


def public_indexes(sources: list[dict[str, str]]) -> set[str]:
    """The names Pipfile.lock gives the indexes that are PyPI."""
    names: set[str] = set()
    for source in sources:
        if source["url"].rstrip("/") == PYPI_INDEX:
            names.add(source["name"])
    return names


def first_index(sources: list[dict[str, str]]) -> str | None:
    """Pipenv installs from the first index it lists unless a package names another."""
    if not sources:
        return None
    return sources[0]["name"]


def pipfile_versions(text: str) -> set[Locked]:
    lock: dict[str, Any] = json.loads(text)
    sources: list[dict[str, str]] = lock.get("_meta", {}).get("sources", [])
    public = public_indexes(sources)
    default_index = first_index(sources)
    versions: set[Locked] = set()
    for section in ("default", "develop"):
        for name, entry in lock.get(section, {}).items():
            version = str(entry.get("version", ""))
            index = entry.get("index", default_index)
            if version.startswith("==") and index in public:
                versions.add((normalized(name), version.removeprefix("==")))
    return versions


def requirements_versions(text: str) -> set[Locked]:
    """The lines pinned with ==, as pip-compile writes them."""
    versions: set[Locked] = set()
    for line in text.splitlines():
        pin = REQUIREMENT_PIN.match(line.strip())
        if pin is not None:
            versions.add((normalized(pin.group(1)), pin.group(2)))
    return versions


def go_sum_versions(text: str) -> set[Locked]:
    """Modules whose code is used. A version ending in /go.mod means only the
    module's go.mod was read."""
    versions: set[Locked] = set()
    for line in text.splitlines():
        fields = line.split()
        if len(fields) != GO_SUM_FIELDS:
            continue
        module, version = fields[0], fields[1]
        if not version.endswith("/go.mod"):
            versions.add((module, version))
    return versions


def is_git_source(source: str) -> bool:
    return source.startswith(GIT_SOURCES) or "#commit=" in source


def repository_name(source: str) -> str:
    """The repository a git source names, for a lockfile line with no package name."""
    location = source.split("#", 1)[0].rstrip("/")
    return location.rsplit("/", 1)[-1].removesuffix(".git")


def package_lock_git_sources(text: str) -> set[Locked]:
    """The packages package-lock.json installs from git, each with its source."""
    packages: dict[str, dict[str, Any]] = json.loads(text).get("packages", {})
    sources: set[Locked] = set()
    for location, entry in packages.items():
        resolved = str(entry.get("resolved", ""))
        if not is_git_source(resolved):
            continue
        # An entry records its name when it differs from where it is installed.
        installed_as = location.rsplit("node_modules/", 1)[-1]
        sources.add((str(entry.get("name", installed_as)), resolved))
    return sources


def pnpm_git_sources(text: str) -> set[Locked]:
    """The keys of the packages section that name a git source."""
    sources: set[Locked] = set()
    for line in pnpm_package_lines(text):
        match = PNPM_GIT_PACKAGE.match(line)
        if match is not None:
            sources.add((match.group(1), match.group(2)))
    return sources


def yarn_git_source(line: str) -> Locked | None:
    """Yarn 1 records a resolved URL with no name, and later versions a name@source."""
    resolved = YARN_RESOLVED.match(line)
    if resolved is not None:
        source = resolved.group(1)
        if not is_git_source(source):
            return None
        return (repository_name(source), source)
    resolution = YARN_RESOLUTION_SOURCE.match(line)
    if resolution is None or not is_git_source(resolution.group(2)):
        return None
    return (resolution.group(1), resolution.group(2))


def yarn_git_sources(text: str) -> set[Locked]:
    sources: set[Locked] = set()
    for line in text.splitlines():
        source = yarn_git_source(line)
        if source is not None:
            sources.add(source)
    return sources


def uv_outside_sources(text: str) -> set[Locked]:
    """The packages uv.lock installs from git or a URL."""
    packages: list[dict[str, Any]] = tomllib.loads(text).get("package", [])
    sources: set[Locked] = set()
    for package in packages:
        source: dict[str, Any] = package.get("source", {})
        outside = source.get("git", source.get("url"))
        if outside is not None:
            sources.add((normalized(package["name"]), str(outside)))
    return sources


def poetry_outside_sources(text: str) -> set[Locked]:
    """The packages poetry.lock installs from git or a URL. A private index is
    recorded as type legacy."""
    packages: list[dict[str, Any]] = tomllib.loads(text).get("package", [])
    sources: set[Locked] = set()
    for package in packages:
        source: dict[str, Any] = package.get("source", {})
        if source.get("type") in {"git", "url"}:
            sources.add((normalized(package["name"]), str(source.get("url", ""))))
    return sources


def pipfile_outside_source(entry: dict[str, Any]) -> str | None:
    """Where a Pipfile.lock entry comes from, when that is git or a URL rather
    than an index or a local file."""
    if "git" in entry:
        return str(entry["git"])
    file_source = str(entry.get("file", ""))
    if file_source.startswith(("http://", "https://")):
        return file_source
    return None


def pipfile_outside_sources(text: str) -> set[Locked]:
    lock: dict[str, Any] = json.loads(text)
    sources: set[Locked] = set()
    for section in ("default", "develop"):
        for name, entry in lock.get(section, {}).items():
            outside = pipfile_outside_source(entry)
            if outside is not None:
                sources.add((normalized(name), outside))
    return sources


LOCKFILES: dict[str, tuple[str, Callable[[str], set[Locked]]]] = {
    "package-lock.json": ("npm", package_lock_versions),
    "npm-shrinkwrap.json": ("npm", package_lock_versions),
    "pnpm-lock.yaml": ("npm", pnpm_versions),
    "yarn.lock": ("npm", yarn_versions),
    "uv.lock": ("pypi", uv_versions),
    "poetry.lock": ("pypi", poetry_versions),
    "Pipfile.lock": ("pypi", pipfile_versions),
    "go.sum": ("go", go_sum_versions),
}


def lockfile_parser(path: str) -> tuple[str, Callable[[str], set[Locked]]] | None:
    """The registry a lockfile's packages come from, and how to read their versions."""
    file_name = Path(path).name
    if file_name.startswith("requirements") and file_name.endswith(".txt"):
        return "pypi", requirements_versions
    return LOCKFILES.get(file_name)


# The lockfiles that can install a package from git or a URL. pip-compile and
# go.sum only pin versions.
OUTSIDE_SOURCES: dict[str, Callable[[str], set[Locked]]] = {
    "package-lock.json": package_lock_git_sources,
    "npm-shrinkwrap.json": package_lock_git_sources,
    "pnpm-lock.yaml": pnpm_git_sources,
    "yarn.lock": yarn_git_sources,
    "uv.lock": uv_outside_sources,
    "poetry.lock": poetry_outside_sources,
    "Pipfile.lock": pipfile_outside_sources,
}


def outside_source_parser(path: str) -> tuple[str, Callable[[str], set[Locked]]] | None:
    """The registry a lockfile belongs to, and how to read the packages it takes
    from git or a URL instead, each with its source."""
    file_name = Path(path).name
    parse = OUTSIDE_SOURCES.get(file_name)
    if parse is None:
        return None
    ecosystem, _ = LOCKFILES[file_name]
    return ecosystem, parse
