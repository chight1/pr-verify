"""Fails a pull request that adds a direct dependency its registry has had for
less than 30 days, or does not have at all: the mark of a package name a model
made up, or of one registered to catch that name. A dependency fetched from git
or a URL fails too, since no registry can tell its age.

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
import urllib.parse
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from dependency_manifests import parser_for

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from dependency_manifests import Requirement

MINIMUM_AGE = timedelta(days=30)
REQUEST_TIMEOUT_SECONDS = 20
HTTP_OK = 200
MISSING_STATUSES = frozenset({404, 410})
GO_VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class Dependency:
    ecosystem: str
    requirement: Requirement


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


def requirements_in_checkout(
    path: str, parse: Callable[[str], set[Requirement]]
) -> set[Requirement]:
    return parse(Path(path).read_text(encoding="utf-8"))


def requirements_at_commit(
    sha: str, path: str, parse: Callable[[str], set[Requirement]]
) -> set[Requirement]:
    """The requirements in a manifest's copy on a commit; none when it had no copy."""
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
        current = requirements_in_checkout(path, parse)
        at_base = requirements_at_commit(base, path, parse)
        new = sorted(current - at_base, key=lambda requirement: requirement.name)
        added.extend(Dependency(ecosystem, requirement) for requirement in new)
    return added


def problem(dependency: Dependency, now: datetime) -> str | None:
    """Why the dependency fails the check, or None when it passes."""
    requirement = dependency.requirement
    label = f"{requirement.name} ({dependency.ecosystem})"
    if requirement.outside_source is not None:
        return (
            f"{label} comes from {requirement.outside_source}, not a registry, "
            "so its age can't be checked."
        )
    published = PUBLISHED[dependency.ecosystem](requirement.name)
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
