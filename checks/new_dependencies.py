"""Fails a pull request that adds a direct dependency its registry has had for
less than 30 days, or does not have at all: the mark of a package name a model
made up, or of one registered to catch that name.

Usage: new_dependencies.py MANIFEST... Compares each manifest with its copy on
the pull request's base commit, read from the event GitHub Actions provides.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import re
import subprocess
import sys
import tomllib
import urllib.parse
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

MINIMUM_AGE = timedelta(days=30)
REQUEST_TIMEOUT_SECONDS = 20
HTTP_OK = 200
MISSING_STATUSES = frozenset({404, 410})
NPM_SECTIONS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
REQUIREMENT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# A go.mod requirement is a module path and a version.
GO_REQUIREMENT_FIELDS = 2
GO_VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class Dependency:
    ecosystem: str
    name: str


def normalized(name: str) -> str:
    """A Python package name as PyPI compares it."""
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_name(spec: str) -> str | None:
    """The package a requirement such as "requests>=2" names."""
    match = REQUIREMENT_NAME.match(spec.strip())
    if match is None:
        return None
    return normalized(match.group(0))


def requirement_names(specs: Iterable[str]) -> set[str]:
    names: set[str] = set()
    for spec in specs:
        name = requirement_name(spec)
        if name is not None:
            names.add(name)
    return names


def npm_names(text: str) -> set[str]:
    manifest: dict[str, Any] = json.loads(text)
    names: set[str] = set()
    for section in NPM_SECTIONS:
        names.update(manifest.get(section, {}))
    return names


def pyproject_names(text: str) -> set[str]:
    document = tomllib.loads(text)
    project: dict[str, Any] = document.get("project", {})
    specs: list[str] = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        specs.extend(group)
    for group in document.get("dependency-groups", {}).values():
        # A group can also include another group by name, as a table.
        specs.extend(spec for spec in group if isinstance(spec, str))
    poetry = document.get("tool", {}).get("poetry", {}).get("dependencies", {})
    specs.extend(name for name in poetry if name != "python")
    return requirement_names(specs)


def requirements_names(text: str) -> set[str]:
    names: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        # Comments, and options such as -r other.txt or --index-url.
        if not line or line.startswith(("#", "-")):
            continue
        name = requirement_name(line)
        if name is not None:
            names.add(name)
    return names


def required_module(code: str, *, in_require_block: bool) -> str | None:
    """The module a go.mod line requires, given the line without its comment."""
    if code.startswith("require "):
        code = code.removeprefix("require ")
    elif not in_require_block:
        return None
    fields = code.split()
    if len(fields) != GO_REQUIREMENT_FIELDS:
        return None
    return fields[0]


def go_names(text: str) -> set[str]:
    """The modules go.mod requires directly, in require lines and blocks."""
    names: set[str] = set()
    in_require_block = False
    for line in text.splitlines():
        if "// indirect" in line:
            continue
        code = line.split("//", 1)[0].strip()
        if code == "require (":
            in_require_block = True
        elif code == ")":
            in_require_block = False
        else:
            module = required_module(code, in_require_block=in_require_block)
            if module is not None:
                names.add(module)
    return names


def parser_for(path: str) -> tuple[str, Callable[[str], set[str]]] | None:
    file_name = Path(path).name
    if file_name == "package.json":
        return "npm", npm_names
    if file_name == "pyproject.toml":
        return "pypi", pyproject_names
    if file_name.startswith("requirements") and file_name.endswith(".txt"):
        return "pypi", requirements_names
    if file_name == "go.mod":
        return "go", go_names
    return None


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)


def base_sha() -> str | None:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        return None
    event: dict[str, Any] = json.loads(Path(event_path).read_text(encoding="utf-8"))
    return event.get("pull_request", {}).get("base", {}).get("sha")


def fetch_commit(sha: str) -> None:
    """The checkout is one commit deep and holds no credentials, so the base
    commit is fetched with the workflow's token when it is not already here."""
    if git("cat-file", "-e", f"{sha}^{{commit}}").returncode == 0:
        return
    token = os.environ.get("GH_TOKEN", "")
    credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    header = f"http.extraHeader=Authorization: basic {credentials}"
    git("-c", header, "fetch", "--depth", "1", "--no-tags", "origin", sha)


def names_in_checkout(path: str, parse: Callable[[str], set[str]]) -> set[str]:
    return parse(Path(path).read_text(encoding="utf-8"))


def names_at_commit(sha: str, path: str, parse: Callable[[str], set[str]]) -> set[str]:
    """The names in a manifest's copy on a commit; none when it had no copy."""
    shown = git("show", f"{sha}:{path}")
    if shown.returncode != 0:
        return set()
    return parse(shown.stdout)


class RegistryError(Exception):
    """A registry answered with neither the package nor its absence."""


def fetch(host: str, path: str) -> bytes | None:
    """The body of an HTTPS GET, or None when the registry has no such package."""
    connection = http.client.HTTPSConnection(host, timeout=REQUEST_TIMEOUT_SECONDS)
    try:
        connection.request("GET", path, headers={"Accept": "application/json"})
        response = connection.getresponse()
        body = response.read()
    finally:
        connection.close()
    if response.status in MISSING_STATUSES:
        return None
    if response.status != HTTP_OK:
        message = f"https://{host}{path} answered {response.status}"
        raise RegistryError(message)
    return body


def fetch_json(host: str, path: str) -> dict[str, Any] | None:
    body = fetch(host, path)
    if body is None:
        return None
    return json.loads(body)


def npm_published(name: str) -> datetime | None:
    package = fetch_json("registry.npmjs.org", f"/{urllib.parse.quote(name, safe='@')}")
    if package is None:
        return None
    return datetime.fromisoformat(package["time"]["created"])


def pypi_published(name: str) -> datetime | None:
    """When the package's first file was uploaded."""
    package = fetch_json("pypi.org", f"/pypi/{urllib.parse.quote(name)}/json")
    if package is None:
        return None
    uploads: list[datetime] = []
    for release_files in package["releases"].values():
        uploads.extend(
            datetime.fromisoformat(upload["upload_time_iso_8601"])
            for upload in release_files
        )
    return min(uploads, default=None)


def go_escaped(module: str) -> str:
    """A module path as the Go module proxy spells it: capitals as !lowercase."""
    return re.sub(r"[A-Z]", lambda capital: "!" + capital.group(0).lower(), module)


def go_version_key(version: str) -> tuple[int, int, int]:
    """Sorts versions by number, with any that are not vX.Y.Z last."""
    match = GO_VERSION.match(version)
    if match is None:
        return (sys.maxsize, 0, 0)
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


def go_version_time(escaped_module: str, version_path: str) -> datetime | None:
    version_info = fetch_json("proxy.golang.org", f"/{escaped_module}/{version_path}")
    if version_info is None:
        return None
    return datetime.fromisoformat(version_info["Time"])


def go_published(module: str) -> datetime | None:
    """When the module's earliest version was published."""
    escaped_module = go_escaped(module)
    listing = fetch("proxy.golang.org", f"/{escaped_module}/@v/list")
    if listing is None:
        return None
    versions = listing.decode().split()
    # A module with no tagged versions has only pseudo-versions, found at @latest.
    if not versions:
        return go_version_time(escaped_module, "@latest")
    earliest = min(versions, key=go_version_key)
    return go_version_time(escaped_module, f"@v/{earliest}.info")


PUBLISHED: dict[str, Callable[[str], datetime | None]] = {
    "npm": npm_published,
    "pypi": pypi_published,
    "go": go_published,
}


def added_dependencies(manifests: Iterable[str], base: str) -> list[Dependency]:
    added: list[Dependency] = []
    for path in manifests:
        parser = parser_for(path)
        if parser is None:
            continue
        ecosystem, parse = parser
        current_names = names_in_checkout(path, parse)
        base_names = names_at_commit(base, path, parse)
        new_names = sorted(current_names - base_names)
        added.extend(Dependency(ecosystem, name) for name in new_names)
    return added


def problem(dependency: Dependency, now: datetime) -> str | None:
    """Why the dependency fails the check, or None when it passes."""
    published = PUBLISHED[dependency.ecosystem](dependency.name)
    label = f"{dependency.name} ({dependency.ecosystem})"
    if published is None:
        return f"{label} is not on its registry. Check the name."
    age = now - published
    if age < MINIMUM_AGE:
        return f"{label} has existed for {age.days} days, under {MINIMUM_AGE.days}."
    return None


def main(manifests: list[str]) -> int:
    base = base_sha()
    if base is None:
        sys.stdout.write("Not a pull request, so there is no base to compare with.\n")
        return 0
    fetch_commit(base)
    now = datetime.now(UTC)
    problems: list[str] = []
    for dependency in added_dependencies(manifests, base):
        found = problem(dependency, now)
        if found is not None:
            problems.append(found)
    for found in problems:
        sys.stderr.write(f"{found}\n")
    if problems:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
