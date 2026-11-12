"""What a manifest asks to install: the dependencies in package.json,
pyproject.toml, requirements files and go.mod, each with where it comes from.
Read by new_dependencies.py.

A dependency on a local path is left out, since its code is in the repository
and the gate checks it there.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

NPM_SECTIONS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
# npm specs that point at a path in the repository.
NPM_LOCAL_SOURCES = ("workspace:", "file:", "link:", "portal:", "./", "../", "/", "~/")
# Specs that fetch code from git or a URL instead of a registry.
OUTSIDE_SOURCES = (
    "git:",
    "git+",
    "github:",
    "gitlab:",
    "bitbucket:",
    "gist:",
    "http:",
    "https:",
)
# Keys of a Poetry or uv dependency table that say where it comes from instead of PyPI.
LOCAL_TABLE_KEYS = ("path", "workspace")
OUTSIDE_TABLE_KEYS = ("git", "url")
REQUIREMENT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# A go.mod requirement is a module path and a version.
GO_REQUIREMENT_FIELDS = 2
# The go.mod directives that bring a module in, and the lines that open a block of them.
GO_DIRECTIVES = ("require", "replace")
GO_BLOCK_STARTS = {"require (": "require", "replace (": "replace"}


@dataclass(frozen=True)
class Requirement:
    """A dependency a manifest names: a registry package, unless it comes from
    git or a URL, whose age no registry can tell."""

    name: str
    outside_source: str | None = None


def normalized(name: str) -> str:
    """A Python package name as PyPI compares it."""
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_name(spec: str) -> str | None:
    """The package a requirement such as "requests>=2" names."""
    match = REQUIREMENT_NAME.match(spec.strip())
    if match is None:
        return None
    return normalized(match.group(0))


def python_requirement(spec: str) -> Requirement | None:
    """A requirement such as "requests>=2", or a direct reference such as
    "package @ git+https://...". A reference to a local file is left out."""
    if spec.startswith(OUTSIDE_SOURCES):
        return Requirement(spec, outside_source=spec)
    name = requirement_name(spec)
    if name is None:
        return None
    if "@" not in spec:
        return Requirement(name)
    reference = spec.split("@", 1)[1].strip()
    if reference.startswith("file:"):
        return None
    return Requirement(name, outside_source=reference)


def python_requirements(specs: Iterable[str]) -> set[Requirement]:
    requirements: set[Requirement] = set()
    for spec in specs:
        requirement = python_requirement(spec)
        if requirement is not None:
            requirements.add(requirement)
    return requirements


def npm_alias_target(spec: str) -> str:
    """The package an alias such as "npm:real-package@1.0.0" installs."""
    target = spec.removeprefix("npm:")
    # A scoped name starts with @, so the version's @ is searched for after it.
    version_at = target.find("@", 1)
    if version_at == -1:
        return target
    return target[:version_at]


def npm_requirement(name: str, spec: object) -> Requirement | None:
    """What a package.json entry installs: a registry version, another registry
    package under this name, a local path, or code from git or a URL."""
    if not isinstance(spec, str):
        return Requirement(name)
    if spec.startswith("npm:"):
        return Requirement(npm_alias_target(spec))
    if spec.startswith(NPM_LOCAL_SOURCES):
        return None
    # "owner/repo" is shorthand for a GitHub repository; a version range has no slash.
    if spec.startswith(OUTSIDE_SOURCES) or "/" in spec:
        return Requirement(name, outside_source=spec)
    return Requirement(name)


def npm_override(selector: str, spec: str) -> Requirement | None:
    """What an override swaps in: another registry package, as "npm:other@1", or
    code from git or a URL. A plain version only pins a package already depended
    on, and a local path is in the repository, so neither names one."""
    requirement = npm_requirement(selector, spec)
    if requirement is None:
        return None
    if spec.startswith("npm:") or requirement.outside_source is not None:
        return requirement
    return None


def npm_overrides(overrides: object) -> set[Requirement]:
    """The packages that npm's overrides, Yarn's resolutions or pnpm's overrides
    swap in."""
    requirements: set[Requirement] = set()
    if not isinstance(overrides, dict):
        return requirements
    table = cast("dict[str, object]", overrides)
    for selector, spec in table.items():
        if not isinstance(spec, str):
            # npm nests the overrides for a dependency's own dependencies in a table.
            requirements.update(npm_overrides(spec))
            continue
        requirement = npm_override(selector, spec)
        if requirement is not None:
            requirements.add(requirement)
    return requirements


def npm_requirements(text: str) -> set[Requirement]:
    manifest: dict[str, Any] = json.loads(text)
    requirements: set[Requirement] = set()
    for section in NPM_SECTIONS:
        for name, spec in manifest.get(section, {}).items():
            requirement = npm_requirement(name, spec)
            if requirement is not None:
                requirements.add(requirement)
    pnpm: dict[str, Any] = manifest.get("pnpm", {})
    requirements.update(npm_overrides(manifest.get("overrides")))
    requirements.update(npm_overrides(manifest.get("resolutions")))
    requirements.update(npm_overrides(pnpm.get("overrides")))
    return requirements


def table_requirement(package: str, spec: object) -> Requirement | None:
    """A Python dependency as Poetry or uv describe it: a version, or a table
    that can name a local path or workspace member, a git repository or a URL."""
    if not isinstance(spec, dict):
        return Requirement(package)
    table = cast("dict[str, object]", spec)
    for local_key in LOCAL_TABLE_KEYS:
        if local_key in table:
            return None
    for outside_key in OUTSIDE_TABLE_KEYS:
        if outside_key in table:
            return Requirement(package, outside_source=str(table[outside_key]))
    return Requirement(package)


def standard_specs(document: dict[str, Any]) -> list[str]:
    """The requirements pyproject.toml lists in the standard tables."""
    project: dict[str, Any] = document.get("project", {})
    specs: list[str] = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        specs.extend(group)
    for group in document.get("dependency-groups", {}).values():
        # A group can also include another group by name, as a table.
        specs.extend(spec for spec in group if isinstance(spec, str))
    return specs


def poetry_tables(tool: dict[str, Any]) -> list[dict[str, Any]]:
    """Poetry's dependency tables: the main one, the older dev-dependencies, and
    one per dependency group."""
    poetry: dict[str, Any] = tool.get("poetry", {})
    groups: dict[str, Any] = poetry.get("group", {})
    tables: list[dict[str, Any]] = [
        poetry.get("dependencies", {}),
        poetry.get("dev-dependencies", {}),
    ]
    tables.extend(group.get("dependencies", {}) for group in groups.values())
    return tables


def poetry_requirements(tool: dict[str, Any]) -> set[Requirement]:
    requirements: set[Requirement] = set()
    for table in poetry_tables(tool):
        for name, spec in table.items():
            # Poetry lists the Python version it needs among the dependencies.
            if name == "python":
                continue
            requirement = table_requirement(normalized(name), spec)
            if requirement is not None:
                requirements.add(requirement)
    return requirements


def uv_sourced(requirement: Requirement, sources: dict[str, Any]) -> Requirement | None:
    """A requirement as uv installs it: from where [tool.uv.sources] says, if it
    names the package, or else from PyPI."""
    source = sources.get(requirement.name)
    if source is None:
        return requirement
    return table_requirement(requirement.name, source)


def pyproject_requirements(text: str) -> set[Requirement]:
    document = tomllib.loads(text)
    tool: dict[str, Any] = document.get("tool", {})
    uv: dict[str, Any] = tool.get("uv", {})
    raw_sources: dict[str, Any] = uv.get("sources", {})
    sources = {normalized(name): source for name, source in raw_sources.items()}
    requirements: set[Requirement] = set()
    for listed in python_requirements(standard_specs(document)):
        requirement = uv_sourced(listed, sources)
        if requirement is not None:
            requirements.add(requirement)
    requirements.update(poetry_requirements(tool))
    return requirements


def requirements_line(line: str) -> Requirement | None:
    """One line of a requirements file. An editable install, "-e target", comes
    from git, a URL or a local directory; other options, such as -r, name nothing."""
    if line.startswith(("-e ", "--editable ")):
        target = line.split(maxsplit=1)[1]
        if target.startswith(OUTSIDE_SOURCES):
            return Requirement(target, outside_source=target)
        return None
    if not line or line.startswith(("#", "-")):
        return None
    return python_requirement(line)


def requirements_file_requirements(text: str) -> set[Requirement]:
    requirements: set[Requirement] = set()
    for line in text.splitlines():
        requirement = requirements_line(line.strip())
        if requirement is not None:
            requirements.add(requirement)
    return requirements


def go_directive(code: str, block: str | None) -> tuple[str, str] | None:
    """A go.mod line's directive and the rest of the line: "require x v1" gives
    ("require", "x v1"), and a line inside a block gives the block's directive."""
    for directive in GO_DIRECTIVES:
        if code.startswith(f"{directive} "):
            return directive, code.removeprefix(f"{directive} ")
    if block is None:
        return None
    return block, code


def required_module(requirement: str) -> str | None:
    """The module in a requirement such as "example.com/module v1.2.3"."""
    fields = requirement.split()
    if len(fields) != GO_REQUIREMENT_FIELDS:
        return None
    return fields[0]


def replacement_module(replacement: str) -> str | None:
    """The module a replace swaps in, as in "old => new v1.2.3". A local
    directory, which has no version, is left out."""
    if "=>" not in replacement:
        return None
    swapped_in = replacement.split("=>", 1)[1]
    return required_module(swapped_in)


def go_module(code: str, block: str | None) -> str | None:
    """The module a go.mod line brings in: required, or swapped in by replace."""
    directive = go_directive(code, block)
    if directive is None:
        return None
    kind, rest = directive
    if kind == "require":
        return required_module(rest)
    return replacement_module(rest)


def go_requirements(text: str) -> set[Requirement]:
    """The modules go.mod requires directly or swaps in with replace, in single
    lines and in blocks."""
    requirements: set[Requirement] = set()
    block: str | None = None
    for line in text.splitlines():
        if "// indirect" in line:
            continue
        code = line.split("//", 1)[0].strip()
        if code in GO_BLOCK_STARTS:
            block = GO_BLOCK_STARTS[code]
            continue
        if code == ")":
            block = None
            continue
        module = go_module(code, block)
        if module is not None:
            requirements.add(Requirement(module))
    return requirements


def manifest_parser(path: str) -> tuple[str, Callable[[str], set[Requirement]]] | None:
    """The ecosystem a manifest belongs to, and the function that reads it."""
    file_name = Path(path).name
    if file_name == "package.json":
        return "npm", npm_requirements
    if file_name == "pyproject.toml":
        return "pypi", pyproject_requirements
    if file_name.startswith("requirements") and file_name.endswith(".txt"):
        return "pypi", requirements_file_requirements
    if file_name == "go.mod":
        return "go", go_requirements
    return None
