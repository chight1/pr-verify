"""Fails a pull request that adds a dependency its registry does not have, the mark
of a package name a model made up, or one too new to trust: a direct dependency
the registry has had for less than 30 days, which may be registered to catch a
made-up name, or any locked version published less than 7 days ago, which is how
a hijacked maintainer account ships malware before anyone notices. A version a
published advisory names as the fix for a vulnerability is not held back. A
direct dependency fetched from git or a URL fails too, since no registry can
tell its age.

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
from lockfiles import lockfile_parser
from registries import CREATED, RELEASED, fixes_advisory

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

    def __str__(self) -> str:
        return f"{self.requirement.name} ({self.ecosystem})"


@dataclass(frozen=True)
class LockedVersion:
    ecosystem: str
    name: str
    version: str

    def __str__(self) -> str:
        return f"{self.name}@{self.version} ({self.ecosystem})"


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


def added_dependencies(paths: Iterable[str], base: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for path in paths:
        parser = manifest_parser(path)
        if parser is None:
            continue
        ecosystem, parse = parser
        new = sorted(added(path, base, parse), key=lambda requirement: requirement.name)
        dependencies.extend(Dependency(ecosystem, requirement) for requirement in new)
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


def age_problem(
    label: str, published: datetime | None, now: datetime, minimum: timedelta
) -> str | None:
    """Why something its registry dates fails, or None when it is old enough."""
    if published is None:
        return f"{label} is not on its registry. Check the name."
    age = now - published
    if age < minimum:
        return f"{label} is {age.days} days old, under the {minimum.days}-day minimum."
    return None


def package_problem(dependency: Dependency, now: datetime) -> str | None:
    requirement = dependency.requirement
    if requirement.outside_source is not None:
        return (
            f"{dependency} comes from {requirement.outside_source}, not a registry, "
            "so its age can't be checked."
        )
    created = CREATED[dependency.ecosystem](requirement.name)
    return age_problem(str(dependency), created, now, MINIMUM_PACKAGE_AGE)


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
    dependencies = added_dependencies(tracked, base)
    versions = added_versions(tracked, base)
    found = problems(dependencies, versions)
    for problem in found:
        sys.stderr.write(f"{problem}\n")
    if found:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
