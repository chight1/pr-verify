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


def npm_requirements(text: str) -> set[Requirement]:
    manifest: dict[str, Any] = json.loads(text)
    requirements: set[Requirement] = set()
    for section in NPM_SECTIONS:
        for name, spec in manifest.get(section, {}).items():
            requirement = npm_requirement(name, spec)
            if requirement is not None:
                requirements.add(requirement)
    return requirements


def poetry_requirement(name: str, spec: object) -> Requirement | None:
    """A Poetry dependency: a version, or a table that can name a local path, a
    git repository or a URL instead."""
    package = normalized(name)
    if not isinstance(spec, dict):
        return Requirement(package)
    table = cast("dict[str, object]", spec)
    if "path" in table:
        return None
    for source_key in ("git", "url"):
        if source_key in table:
            return Requirement(package, outside_source=str(table[source_key]))
    return Requirement(package)


def pyproject_requirements(text: str) -> set[Requirement]:
    document = tomllib.loads(text)
    project: dict[str, Any] = document.get("project", {})
    specs: list[str] = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        specs.extend(group)
    for group in document.get("dependency-groups", {}).values():
        # A group can also include another group by name, as a table.
        specs.extend(spec for spec in group if isinstance(spec, str))
    requirements = python_requirements(specs)
    tool: dict[str, Any] = document.get("tool", {})
    poetry: dict[str, Any] = tool.get("poetry", {}).get("dependencies", {})
    for name, spec in poetry.items():
        if name == "python":
            continue
        requirement = poetry_requirement(name, spec)
        if requirement is not None:
            requirements.add(requirement)
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


def parser_for(path: str) -> tuple[str, Callable[[str], set[Requirement]]] | None:
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
