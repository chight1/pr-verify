"""Fails a pull request whose dependencies its registry cannot vouch for.

Every direct dependency fails when its registry does not have it, the mark of a
package name a model made up or of one the registry removed as malware, and when
it comes from git or a URL, which no registry dates. One the pull request adds
also fails when the registry has had it for less than 30 days, since it may be
registered to catch a made-up name. A version the pull request adds to a
lockfile fails when it was published less than 7 days ago, which is how a
hijacked maintainer account ships malware before anyone notices, unless a
published advisory names it as the fix for a vulnerability, and a package it
adds to a lockfile from git or a URL fails, as a direct one does.

Usage: new_dependencies.py. Compares each tracked manifest and lockfile with its
copy on the pull request's base commit, read from the event GitHub Actions provides.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from dependency_manifests import manifest_parser
from lockfile_parsing import lockfile_parser, outside_source_parser
from registry_lookups import CREATED, RELEASED, fixes_advisory

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from dependency_manifests import Requirement

MINIMUM_PACKAGE_AGE = timedelta(days=30)
MINIMUM_VERSION_AGE = timedelta(days=7)
LOOKUP_THREADS = 16

Parsed = TypeVar("Parsed")


@dataclass(frozen=True)
class Dependency:
    ecosystem: str
    requirement: Requirement
    # Whether the pull request adds it, rather than the base commit having it.
    added: bool

    def __str__(self) -> str:
        return f"{self.requirement.name} ({self.ecosystem})"


@dataclass(frozen=True)
class LockedVersion:
    ecosystem: str
    name: str
    version: str

    def __str__(self) -> str:
        return f"{self.name}@{self.version} ({self.ecosystem})"


@dataclass(frozen=True)
class LockedSource:
    """A package a lockfile installs from git or a URL rather than a registry."""

    ecosystem: str
    name: str
    source: str

    def __str__(self) -> str:
        return f"{self.name} ({self.ecosystem})"


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


def parsed_in_checkout(path: str, parse: Callable[[str], set[Parsed]]) -> set[Parsed]:
    return parse(Path(path).read_text(encoding="utf-8"))


def parsed_at_commit(
    sha: str, path: str, parse: Callable[[str], set[Parsed]]
) -> set[Parsed]:
    """What a file held on a commit; nothing when the commit had no such file."""
    shown = git("show", f"{sha}:{path}")
    if shown.returncode != 0:
        return set()
    return parse(shown.stdout)


def added(path: str, base: str, parse: Callable[[str], set[Parsed]]) -> set[Parsed]:
    """What a file holds now that it did not hold on the base commit."""
    return parsed_in_checkout(path, parse) - parsed_at_commit(base, path, parse)


def direct_dependencies(paths: Iterable[str], base: str) -> list[Dependency]:
    """Every dependency the manifests name, each marked as added or already there."""
    dependencies: list[Dependency] = []
    for path in paths:
        parser = manifest_parser(path)
        if parser is None:
            continue
        ecosystem, parse = parser
        current = parsed_in_checkout(path, parse)
        at_base = parsed_at_commit(base, path, parse)
        for requirement in sorted(current, key=lambda listed: listed.name):
            added_here = requirement not in at_base
            dependencies.append(Dependency(ecosystem, requirement, added=added_here))
    return dependencies


def added_versions(paths: Iterable[str], base: str) -> list[LockedVersion]:
    versions: list[LockedVersion] = []
    for path in paths:
        parser = lockfile_parser(path)
        if parser is None:
            continue
        ecosystem, parse = parser
        new = sorted(added(path, base, parse))
        versions.extend(
            LockedVersion(ecosystem, name, version) for name, version in new
        )
    return versions


def not_on_registry(label: str) -> str:
    return f"{label} is not on its registry. Check the name."


def age_problem(
    label: str, published: datetime | None, now: datetime, minimum: timedelta
) -> str | None:
    """Why something its registry dates fails, or None when it is old enough."""
    if published is None:
        return not_on_registry(label)
    age = now - published
    if age < minimum:
        return f"{label} is {age.days} days old, under the {minimum.days}-day minimum."
    return None


def package_problem(dependency: Dependency, now: datetime) -> str | None:
    requirement = dependency.requirement
    if requirement.outside_source is not None:
        return (
            f"{dependency} comes from {requirement.outside_source}, not a registry. "
            "Publish it to one, or keep its code in the repository."
        )
    created = CREATED[dependency.ecosystem](requirement.name)
    if created is None:
        return not_on_registry(str(dependency))
    # One already on the base commit was old enough when it was added.
    if not dependency.added:
        return None
    return age_problem(str(dependency), created, now, MINIMUM_PACKAGE_AGE)


def added_sources(paths: Iterable[str], base: str) -> list[LockedSource]:
    sources: list[LockedSource] = []
    for path in paths:
        parser = outside_source_parser(path)
        if parser is None:
            continue
        ecosystem, parse = parser
        new = sorted(added(path, base, parse))
        sources.extend(LockedSource(ecosystem, name, source) for name, source in new)
    return sources


def source_problem(locked: LockedSource) -> str:
    return (
        f"{locked} is locked to {locked.source}, not a registry. "
        "Publish it to one, or keep its code in the repository."
    )


def version_problem(locked: LockedVersion, now: datetime) -> str | None:
    released = RELEASED[locked.ecosystem](locked.name, locked.version)
    problem = age_problem(str(locked), released, now, MINIMUM_VERSION_AGE)
    if problem is None or released is None:
        return problem
    # A version too new to trust still passes when an advisory names it as a fix,
    # so a security update is never held back.
    if fixes_advisory(locked.ecosystem, locked.name, locked.version):
        return None
    return problem


def problems(
    dependencies: list[Dependency], versions: list[LockedVersion]
) -> list[str]:
    """Every failure, with the registries asked many packages at a time."""
    now = datetime.now(UTC)
    check_package = partial(package_problem, now=now)
    check_version = partial(version_problem, now=now)
    with ThreadPoolExecutor(max_workers=LOOKUP_THREADS) as pool:
        package_results = list(pool.map(check_package, dependencies))
        version_results = list(pool.map(check_version, versions))
    found = [result for result in package_results if result is not None]
    found.extend(result for result in version_results if result is not None)
    return found


def main() -> int:
    base = base_sha()
    if base is None:
        sys.stdout.write("Not a pull request, so there is no base to compare with.\n")
        return 0
    fetch_commit(base)
    # Lockfiles are among the files the other checks leave out, so every tracked
    # file is read here.
    tracked = git("ls-files").stdout.splitlines()
    dependencies = direct_dependencies(tracked, base)
    versions = added_versions(tracked, base)
    found = [source_problem(locked) for locked in added_sources(tracked, base)]
    found.extend(problems(dependencies, versions))
    for problem in found:
        sys.stderr.write(f"{problem}\n")
    if found:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
