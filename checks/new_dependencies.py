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
    match = REQUIREMENT_NAME.match(spec.strip())
    return normalized(match.group(0)) if match else None


def npm_names(text: str) -> set[str]:
    manifest: dict[str, Any] = json.loads(text)
    return {name for section in NPM_SECTIONS for name in manifest.get(section, {})}


def pyproject_names(text: str) -> set[str]:
    document = tomllib.loads(text)
    project: dict[str, Any] = document.get("project", {})
    specs: list[str] = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        specs.extend(group)
    for group in document.get("dependency-groups", {}).values():
        specs.extend(spec for spec in group if isinstance(spec, str))
    poetry = document.get("tool", {}).get("poetry", {}).get("dependencies", {})
    specs.extend(name for name in poetry if name != "python")
    return {name for spec in specs if (name := requirement_name(spec))}


def requirements_names(text: str) -> set[str]:
    lines = (line.strip() for line in text.splitlines())
    specs = (line for line in lines if line and not line.startswith(("#", "-")))
    return {name for spec in specs if (name := requirement_name(spec))}


def go_requirement(line: str, *, in_block: bool) -> str | None:
    """The module a go.mod line requires directly, if it requires one."""
    if "// indirect" in line:
        return None
    code = line.split("//", 1)[0].strip()
    if code.startswith("require ") and not code.endswith("("):
        code = code.removeprefix("require ")
    elif not in_block:
        return None
    parts = code.split()
    return parts[0] if len(parts) == GO_REQUIREMENT_FIELDS else None


def go_names(text: str) -> set[str]:
    names: set[str] = set()
    in_block = False
    for line in text.splitlines():
        code = line.split("//", 1)[0].strip()
        if code in {"require (", ")"}:
            in_block = code == "require ("
        elif name := go_requirement(line, in_block=in_block):
            names.add(name)
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


def names_at(sha: str | None, path: str, parse: Callable[[str], set[str]]) -> set[str]:
    if sha is None:
        text = Path(path).read_text(encoding="utf-8")
    else:
        shown = git("show", f"{sha}:{path}")
        if shown.returncode != 0:
            return set()
        text = shown.stdout
    return parse(text)


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
    return json.loads(body) if body is not None else None


def npm_published(name: str) -> datetime | None:
    package = fetch_json("registry.npmjs.org", f"/{urllib.parse.quote(name, safe='@')}")
    return datetime.fromisoformat(package["time"]["created"]) if package else None


def pypi_published(name: str) -> datetime | None:
    package = fetch_json("pypi.org", f"/pypi/{urllib.parse.quote(name)}/json")
    if not package:
        return None
    uploads = [
        datetime.fromisoformat(file["upload_time_iso_8601"])
        for files in package["releases"].values()
        for file in files
    ]
    return min(uploads, default=None)


def go_escaped(module: str) -> str:
    """A module path as the Go module proxy spells it: capitals as !lowercase."""
    return re.sub(r"[A-Z]", lambda capital: "!" + capital.group(0).lower(), module)


def go_version_key(version: str) -> tuple[int, int, int]:
    match = GO_VERSION.match(version)
    if not match:
        return (sys.maxsize, 0, 0)
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


def go_published(module: str) -> datetime | None:
    escaped = go_escaped(module)
    listing = fetch("proxy.golang.org", f"/{escaped}/@v/list")
    if listing is None:
        return None
    versions = listing.decode().split()
    target = f"@v/{min(versions, key=go_version_key)}.info" if versions else "@latest"
    version_info = fetch_json("proxy.golang.org", f"/{escaped}/{target}")
    return datetime.fromisoformat(version_info["Time"]) if version_info else None


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
        new = names_at(None, path, parse) - names_at(base, path, parse)
        added.extend(Dependency(ecosystem, name) for name in sorted(new))
    return added


def problem(dependency: Dependency, now: datetime) -> str | None:
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
    problems = [
        found
        for dependency in added_dependencies(manifests, base)
        if (found := problem(dependency, now))
    ]
    for found in problems:
        sys.stderr.write(f"{found}\n")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
