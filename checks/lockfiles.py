"""The exact versions a lockfile installs from a public registry, read with the
standard library. Packages from git, a path or another registry are left out,
since the public registries cannot date them.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from registries import normalized

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
GO_SUM_FIELDS = 3


def npm_tarball(url: str) -> Locked | None:
    """The package and version of a tarball URL on the npm registry."""
    match = NPM_TARBALL.match(url)
    return (match.group(1), match.group(3)) if match else None


def package_lock_versions(text: str) -> set[Locked]:
    packages: dict[str, dict[str, Any]] = json.loads(text).get("packages", {})
    tarballs = (str(entry.get("resolved", "")) for entry in packages.values())
    return {locked for url in tarballs if (locked := npm_tarball(url))}


def pnpm_versions(text: str) -> set[Locked]:
    """The keys of the packages section, such as left-pad@1.3.0. A key whose version
    does not start with a digit points at a URL, a path or a git commit."""
    versions: set[Locked] = set()
    in_packages = False
    for line in text.splitlines():
        if line and not line.startswith(" "):
            in_packages = line.rstrip() == "packages:"
        elif in_packages and (match := PNPM_PACKAGE.match(line)):
            versions.add((match.group(1), match.group(2)))
    return versions


def yarn_entry(line: str) -> Locked | None:
    """Yarn 1 records a tarball URL, and later versions a name@npm:version."""
    if resolved := YARN_RESOLVED.match(line):
        return npm_tarball(resolved.group(1))
    if resolution := YARN_RESOLUTION.match(line):
        return (resolution.group(1), resolution.group(2))
    return None


def yarn_versions(text: str) -> set[Locked]:
    return {locked for line in text.splitlines() if (locked := yarn_entry(line))}


def uv_versions(text: str) -> set[Locked]:
    packages: list[dict[str, Any]] = tomllib.loads(text).get("package", [])
    return {
        (normalized(package["name"]), package["version"])
        for package in packages
        if package.get("source", {}).get("registry") == PYPI_INDEX
    }


def poetry_versions(text: str) -> set[Locked]:
    """Poetry records a source only for a package that does not come from PyPI."""
    packages: list[dict[str, Any]] = tomllib.loads(text).get("package", [])
    return {
        (normalized(package["name"]), package["version"])
        for package in packages
        if "source" not in package
    }


def pipfile_versions(text: str) -> set[Locked]:
    """A package names its index only when it is not the first one listed."""
    lock: dict[str, Any] = json.loads(text)
    sources: list[dict[str, str]] = lock.get("_meta", {}).get("sources", [])
    public = {
        source["name"] for source in sources if source["url"].rstrip("/") == PYPI_INDEX
    }
    default_index = sources[0]["name"] if sources else None
    versions: set[Locked] = set()
    for section in ("default", "develop"):
        for name, entry in lock.get(section, {}).items():
            version = str(entry.get("version", ""))
            if version.startswith("==") and entry.get("index", default_index) in public:
                versions.add((normalized(name), version.removeprefix("==")))
    return versions


def requirements_versions(text: str) -> set[Locked]:
    """The lines pinned with ==, as pip-compile writes them."""
    pins = (REQUIREMENT_PIN.match(line.strip()) for line in text.splitlines())
    return {(normalized(pin.group(1)), pin.group(2)) for pin in pins if pin}


def go_sum_versions(text: str) -> set[Locked]:
    """Modules whose code is used. A version ending in /go.mod means only
    the module's go.mod was read."""
    lines = (line.split() for line in text.splitlines())
    return {
        (fields[0], fields[1])
        for fields in lines
        if len(fields) == GO_SUM_FIELDS and not fields[1].endswith("/go.mod")
    }


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
