"""Fails a pull request that adds a dependency its registry does not have, the mark
of a package name a model made up, or one too new to trust: a direct dependency
the registry has had for less than 30 days, which may be registered to catch a
made-up name, or any locked version published less than 7 days ago, which is
how a hijacked maintainer account ships malware before anyone notices.

Usage: new_dependencies.py. Compares each tracked manifest and lockfile with its
copy on the pull request's base commit, read from the event GitHub Actions provides.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from lockfiles import lockfile_parser
from registries import CREATED, RELEASED, normalized

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

MINIMUM_PACKAGE_AGE = timedelta(days=30)
MINIMUM_VERSION_AGE = timedelta(days=7)
LOOKUP_THREADS = 16
NPM_SECTIONS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
REQUIREMENT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
GO_REQUIREMENT_FIELDS = 2

Parsed = TypeVar("Parsed")


@dataclass(frozen=True)
class Dependency:
    ecosystem: str
    name: str

    def __str__(self) -> str:
        return f"{self.name} ({self.ecosystem})"


@dataclass(frozen=True)
class LockedVersion:
    ecosystem: str
    name: str
    version: str

    def __str__(self) -> str:
        return f"{self.name}@{self.version} ({self.ecosystem})"


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


def manifest_parser(path: str) -> tuple[str, Callable[[str], set[str]]] | None:
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


def parsed_at(
    sha: str | None, path: str, parse: Callable[[str], set[Parsed]]
) -> set[Parsed]:
    """What a file holds in the working tree, or on a commit when one is given."""
    if sha is None:
        return parse(Path(path).read_text(encoding="utf-8"))
    shown = git("show", f"{sha}:{path}")
    return parse(shown.stdout) if shown.returncode == 0 else set()


def added(path: str, base: str, parse: Callable[[str], set[Parsed]]) -> set[Parsed]:
    return parsed_at(None, path, parse) - parsed_at(base, path, parse)


def added_dependencies(paths: Iterable[str], base: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for path in paths:
        if parser := manifest_parser(path):
            ecosystem, parse = parser
            names = sorted(added(path, base, parse))
            dependencies.extend(Dependency(ecosystem, name) for name in names)
    return dependencies


def added_versions(paths: Iterable[str], base: str) -> list[LockedVersion]:
    versions: list[LockedVersion] = []
    for path in paths:
        if parser := lockfile_parser(path):
            ecosystem, parse = parser
            locked = sorted(added(path, base, parse))
            versions.extend(LockedVersion(ecosystem, *entry) for entry in locked)
    return versions


def age_problem(
    label: str, published: datetime | None, now: datetime, minimum: timedelta
) -> str | None:
    if published is None:
        return f"{label} is not on its registry. Check the name."
    age = now - published
    if age < minimum:
        return f"{label} is {age.days} days old, under the {minimum.days}-day minimum."
    return None


def package_problem(dependency: Dependency, now: datetime) -> str | None:
    created = CREATED[dependency.ecosystem](dependency.name)
    return age_problem(str(dependency), created, now, MINIMUM_PACKAGE_AGE)


def version_problem(locked: LockedVersion, now: datetime) -> str | None:
    released = RELEASED[locked.ecosystem](locked.name, locked.version)
    return age_problem(str(locked), released, now, MINIMUM_VERSION_AGE)


def problems(
    dependencies: list[Dependency], versions: list[LockedVersion]
) -> list[str]:
    now = datetime.now(UTC)
    with ThreadPoolExecutor(max_workers=LOOKUP_THREADS) as pool:
        packages = pool.map(partial(package_problem, now=now), dependencies)
        releases = pool.map(partial(version_problem, now=now), versions)
        return [found for found in (*packages, *releases) if found]


def main() -> int:
    base = base_sha()
    if base is None:
        sys.stdout.write("Not a pull request, so there is no base to compare with.\n")
        return 0
    fetch_commit(base)
    tracked = git("ls-files").stdout.splitlines()
    found = problems(added_dependencies(tracked, base), added_versions(tracked, base))
    for problem in found:
        sys.stderr.write(f"{problem}\n")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
