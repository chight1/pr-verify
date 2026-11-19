"""What a C++ manifest asks to install: the ports in vcpkg.json and the packages
in conanfile.txt. conanfile.py is code rather than data, so it is not read.

Only packages from the registries the check can look up are returned: vcpkg's
curated registry and ConanCenter. Ones from another registry are left out, as
private ones are in every ecosystem, and so are vcpkg ports kept in the
repository.
"""

from __future__ import annotations

import json
from fnmatch import fnmatchcase
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any, cast

from requirement import Requirement

if TYPE_CHECKING:
    from collections.abc import Iterable

VCPKG_REPOSITORY = "https://github.com/microsoft/vcpkg"
BUILT_IN_REGISTRY = {"kind": "builtin"}
# The sections of conanfile.txt that list packages.
CONAN_SECTIONS = (
    "[requires]",
    "[tool_requires]",
    "[test_requires]",
    "[build_requires]",
)


def vcpkg_port(entry: object) -> str | None:
    """A vcpkg.json dependency: a port's name, or a table that holds one."""
    if isinstance(entry, str):
        return entry
    if not isinstance(entry, dict):
        return None
    name = cast("dict[str, object]", entry).get("name")
    if isinstance(name, str):
        return name
    return None


def is_curated(registry: dict[str, Any]) -> bool:
    """Whether a registry is vcpkg's curated one: built into vcpkg, or its git
    repository named outright."""
    if registry.get("kind") == "builtin":
        return True
    repository = str(registry.get("repository", "")).removesuffix(".git").rstrip("/")
    return registry.get("kind") == "git" and repository == VCPKG_REPOSITORY


def from_curated_registry(port: str, configuration: dict[str, Any]) -> bool:
    """Whether vcpkg installs a port from its curated registry: the registry
    whose packages name the port, or else the default registry, built in unless
    the configuration names another or none."""
    for registry in configuration.get("registries", []):
        if any(fnmatchcase(port, pattern) for pattern in registry.get("packages", [])):
            return is_curated(registry)
    default = configuration.get("default-registry", BUILT_IN_REGISTRY)
    return default is not None and is_curated(default)


def vcpkg_requirements(text: str) -> set[Requirement]:
    """The ports vcpkg.json depends on that come from the curated registry. The
    registries come from its vcpkg-configuration table, where
    with_vcpkg_configuration puts a vcpkg-configuration.json kept beside it."""
    manifest: dict[str, Any] = json.loads(text)
    configuration: dict[str, Any] = manifest.get("vcpkg-configuration", {})
    requirements: set[Requirement] = set()
    for entry in manifest.get("dependencies", []):
        port = vcpkg_port(entry)
        if port is not None and from_curated_registry(port, configuration):
            requirements.add(Requirement(port))
    return requirements


def with_vcpkg_configuration(manifest: str, configuration: str | None) -> str:
    """vcpkg.json with the vcpkg-configuration.json beside it embedded, since
    vcpkg reads the two together."""
    if configuration is None:
        return manifest
    document: dict[str, Any] = json.loads(manifest)
    document["vcpkg-configuration"] = json.loads(configuration)
    return json.dumps(document)


def local_vcpkg_ports(paths: Iterable[str]) -> set[str]:
    """The ports kept in the repository, as overlays: each folder that holds a
    portfile.cmake is a port of that folder's name."""
    ports: set[str] = set()
    for path in paths:
        file = PurePosixPath(path)
        if file.name == "portfile.cmake":
            ports.add(file.parent.name)
    return ports


def conan_package(reference: str) -> str | None:
    """The package a reference such as zlib/1.3.1 names. ConanCenter publishes
    no package with a user and channel, as in zlib/1.3.1@company/stable, so one
    with them comes from another remote."""
    if "@" in reference:
        return None
    name = reference.split("/", 1)[0].strip()
    return name or None


def conan_requirements(text: str) -> set[Requirement]:
    """The packages conanfile.txt requires, in each section that lists them."""
    requirements: set[Requirement] = set()
    section = ""
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if line.startswith("["):
            section = line
            continue
        if section not in CONAN_SECTIONS or not line:
            continue
        package = conan_package(line)
        if package is not None:
            requirements.add(Requirement(package))
    return requirements
