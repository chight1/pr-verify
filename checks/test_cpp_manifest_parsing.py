import json

from cpp_manifest_parsing import (
    conan_requirements,
    local_vcpkg_ports,
    vcpkg_requirements,
    with_vcpkg_configuration,
)
from manifest_parsing import manifest_parser
from requirement import Requirement

FMT = Requirement("fmt")
ZLIB = Requirement("zlib")


def test_vcpkg_reads_names_and_tables() -> None:
    manifest = {"dependencies": ["fmt", {"name": "zlib", "features": ["x"]}, 7]}
    assert vcpkg_requirements(json.dumps(manifest)) == {FMT, ZLIB}


def test_vcpkg_leaves_out_ports_from_another_registry() -> None:
    company = {
        "kind": "git",
        "repository": "https://example.com/company/ports",
        "packages": ["company-*"],
    }
    manifest = {
        "dependencies": ["fmt", "company-logging"],
        "vcpkg-configuration": {"registries": [company]},
    }
    assert vcpkg_requirements(json.dumps(manifest)) == {FMT}


def test_vcpkg_leaves_out_every_port_when_the_default_registry_is_another() -> None:
    company = {"kind": "git", "repository": "https://example.com/company/ports"}
    curated = {"kind": "git", "repository": "https://github.com/microsoft/vcpkg.git"}
    nothing: set[Requirement] = set()
    for default, expected in ((company, nothing), (None, nothing), (curated, {FMT})):
        manifest = {
            "dependencies": ["fmt"],
            "vcpkg-configuration": {"default-registry": default},
        }
        assert vcpkg_requirements(json.dumps(manifest)) == expected


def test_vcpkg_configuration_beside_the_manifest_is_read_with_it() -> None:
    manifest = json.dumps({"dependencies": ["company-logging"]})
    configuration = json.dumps(
        {"registries": [{"kind": "filesystem", "packages": ["company-logging"]}]}
    )
    combined = with_vcpkg_configuration(manifest, configuration)
    assert vcpkg_requirements(combined) == set()
    assert with_vcpkg_configuration(manifest, None) == manifest


def test_ports_kept_in_the_repository_are_found_by_their_portfile() -> None:
    paths = ["ports/company-logging/portfile.cmake", "ports/notes.txt", "src/a.cpp"]
    assert local_vcpkg_ports(paths) == {"company-logging"}


def test_conan_reads_each_package_section_and_skips_other_remotes() -> None:
    conanfile = """[requires]
zlib/1.3.1  # compression
company-logging/2.0@company/stable

[tool_requires]
cmake/[>=3.28]

[options]
zlib/*:shared=True
"""
    assert conan_requirements(conanfile) == {ZLIB, Requirement("cmake")}


def test_cpp_manifests_are_recognized_by_name() -> None:
    assert manifest_parser("vcpkg.json") == ("vcpkg", vcpkg_requirements)
    assert manifest_parser("app/conanfile.txt") == ("conan", conan_requirements)
    assert manifest_parser("conanfile.py") is None
