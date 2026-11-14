import json

from lockfile_parsing import (
    go_sum_versions,
    lockfile_parser,
    outside_source_parser,
    package_lock_git_sources,
    package_lock_versions,
    pipfile_outside_sources,
    pipfile_versions,
    pnpm_git_sources,
    pnpm_versions,
    poetry_outside_sources,
    poetry_versions,
    requirements_versions,
    uv_outside_sources,
    uv_versions,
    yarn_git_sources,
    yarn_versions,
)

LEFT_PAD = ("left-pad", "1.3.0")
TYPES_NODE = ("@types/node", "22.0.0")
PYYAML = ("pyyaml", "6.0.2")
FORK = "git+ssh://git@github.com/example/forked.git#abc"


def test_package_lock_reads_registry_tarballs_only() -> None:
    lock = {
        "packages": {
            "": {"name": "app"},
            "node_modules/left-pad": {
                "version": "1.3.0",
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
            },
            "node_modules/@types/node": {
                "version": "22.0.0",
                "resolved": "https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz",
            },
            "node_modules/local": {"resolved": "packages/local", "link": True},
            "node_modules/forked": {
                "version": "1.0.0",
                "resolved": "git+ssh://git@github.com/example/forked.git#abc",
            },
        }
    }
    assert package_lock_versions(json.dumps(lock)) == {LEFT_PAD, TYPES_NODE}


def test_package_lock_reads_an_alias_as_the_real_package() -> None:
    alias = {
        "name": "left-pad",
        "version": "1.3.0",
        "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
    }
    lock = {"packages": {"node_modules/pad": alias}}
    assert package_lock_versions(json.dumps(lock)) == {LEFT_PAD}


def test_pnpm_reads_the_packages_section_only() -> None:
    lock = """lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:

  '@types/node@22.0.0':
    resolution: {integrity: sha512-x}

  left-pad@1.3.0:
    resolution: {integrity: sha512-y}

  forked@https://codeload.github.com/example/forked/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/example/forked/tar.gz/abc}

snapshots:

  other@2.0.0: {}
"""
    assert pnpm_versions(lock) == {LEFT_PAD, TYPES_NODE}


def test_pnpm_reads_version_6_keys_with_peers() -> None:
    lock = """packages:

  /left-pad@1.3.0:
    resolution: {integrity: sha512-y}

  /@types/node@22.0.0(typescript@5.0.0):
    resolution: {integrity: sha512-x}
"""
    assert pnpm_versions(lock) == {LEFT_PAD, TYPES_NODE}


def test_yarn_1_reads_registry_tarballs() -> None:
    lock = """# yarn lockfile v1


"@types/node@^22.0.0":
  version "22.0.0"
  resolved "https://registry.yarnpkg.com/@types/node/-/node-22.0.0.tgz#abc"

left-pad@^1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#def"
"""
    assert yarn_versions(lock) == {LEFT_PAD, TYPES_NODE}


def test_yarn_berry_reads_npm_resolutions_only() -> None:
    lock = """__metadata:
  version: 8

"left-pad@npm:^1.3.0":
  version: 1.3.0
  resolution: "left-pad@npm:1.3.0"

"@types/node@npm:^22.0.0":
  version: 22.0.0
  resolution: "@types/node@npm:22.0.0"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
"""
    assert yarn_versions(lock) == {LEFT_PAD, TYPES_NODE}


def test_uv_reads_packages_from_pypi_only() -> None:
    lock = """[[package]]
name = "PyYAML"
version = "6.0.2"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
"""
    assert uv_versions(lock) == {PYYAML}


def test_poetry_skips_packages_with_a_source() -> None:
    lock = """[[package]]
name = "PyYAML"
version = "6.0.2"

[[package]]
name = "forked"
version = "1.0.0"

[package.source]
type = "git"
url = "https://github.com/example/forked.git"
"""
    assert poetry_versions(lock) == {PYYAML}


def test_pipfile_reads_pinned_packages_from_pypi_only() -> None:
    lock = {
        "_meta": {
            "sources": [
                {"name": "pypi", "url": "https://pypi.org/simple"},
                {"name": "private", "url": "https://packages.example.test/simple"},
            ]
        },
        "default": {
            "PyYAML": {"version": "==6.0.2"},
            "internal": {"version": "==1.0.0", "index": "private"},
            "forked": {"git": "https://github.com/example/forked.git"},
        },
        "develop": {"pytest": {"version": "==9.1.1"}},
    }
    assert pipfile_versions(json.dumps(lock)) == {PYYAML, ("pytest", "9.1.1")}


def test_requirements_reads_exact_pins_only() -> None:
    requirements = r"""PyYAML==6.0.2 \
    --hash=sha256:abc
requests[socks]==2.32.3 ; python_version >= "3.9"
flask>=3
-r other.txt
"""
    assert requirements_versions(requirements) == {PYYAML, ("requests", "2.32.3")}


def test_go_sum_skips_modules_used_only_for_their_go_mod() -> None:
    sums = """github.com/google/uuid v1.6.0 h1:abc=
github.com/google/uuid v1.6.0/go.mod h1:def=
golang.org/x/mod v0.20.0/go.mod h1:ghi=
"""
    assert go_sum_versions(sums) == {("github.com/google/uuid", "v1.6.0")}


def test_lockfiles_are_recognized_by_name() -> None:
    assert lockfile_parser("web/yarn.lock") == ("npm", yarn_versions)
    assert lockfile_parser("requirements-dev.txt") == ("pypi", requirements_versions)
    assert lockfile_parser("package.json") is None


def test_package_lock_reads_git_sources_by_package_name() -> None:
    lock = {
        "packages": {
            "node_modules/forked": {"version": "1.0.0", "resolved": FORK},
            "node_modules/pad": {"name": "left-pad", "resolved": FORK},
            "node_modules/left-pad": {
                "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"
            },
        }
    }
    assert package_lock_git_sources(json.dumps(lock)) == {
        ("forked", FORK),
        ("left-pad", FORK),
    }


def test_pnpm_reads_git_keys_only() -> None:
    lock = """lockfileVersion: '9.0'

packages:

  forked@git+https://github.com/example/forked.git#abc:
    resolution: {commit: abc}

  left-pad@1.3.0:
    resolution: {integrity: sha512-abc}
"""
    source = "git+https://github.com/example/forked.git#abc"
    assert pnpm_git_sources(lock) == {("forked", source)}


def test_yarn_reads_git_sources_from_every_version() -> None:
    lock = """"forked@git+https://github.com/example/forked.git":
  version "1.0.0"
  resolved "git+https://github.com/example/forked.git#abc"

"other@https://github.com/example/other.git":
  resolution: "other@https://github.com/example/other.git#commit=def"

left-pad@^1.3.0:
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#def"
"""
    assert yarn_git_sources(lock) == {
        ("forked", "git+https://github.com/example/forked.git#abc"),
        ("other", "https://github.com/example/other.git#commit=def"),
    }


def test_uv_reads_git_and_url_sources() -> None:
    lock = """[[package]]
name = "Forked"
version = "1.0.0"
source = { git = "https://github.com/example/forked?rev=abc" }

[[package]]
name = "wheel-only"
version = "1.0.0"
source = { url = "https://example.com/wheel_only-1.0.0.whl" }

[[package]]
name = "PyYAML"
version = "6.0.2"
source = { registry = "https://pypi.org/simple" }
"""
    assert uv_outside_sources(lock) == {
        ("forked", "https://github.com/example/forked?rev=abc"),
        ("wheel-only", "https://example.com/wheel_only-1.0.0.whl"),
    }


def test_poetry_reads_git_and_url_sources_but_not_private_indexes() -> None:
    lock = """[[package]]
name = "forked"
version = "1.0.0"

[package.source]
type = "git"
url = "https://github.com/example/forked.git"

[[package]]
name = "internal"
version = "1.0.0"

[package.source]
type = "legacy"
url = "https://pypi.example.com/simple"
"""
    assert poetry_outside_sources(lock) == {
        ("forked", "https://github.com/example/forked.git")
    }


def test_pipfile_reads_git_and_remote_files_but_not_local_ones() -> None:
    lock = {
        "default": {
            "forked": {"git": "https://github.com/example/forked.git", "ref": "abc"},
            "remote": {"file": "https://example.com/remote-1.0.0.tar.gz"},
            "local": {"file": "./vendor/local-1.0.0.tar.gz"},
            "pyyaml": {"version": "==6.0.2"},
        }
    }
    assert pipfile_outside_sources(json.dumps(lock)) == {
        ("forked", "https://github.com/example/forked.git"),
        ("remote", "https://example.com/remote-1.0.0.tar.gz"),
    }


def test_lockfiles_that_only_pin_versions_have_no_outside_sources() -> None:
    assert outside_source_parser("web/yarn.lock") == ("npm", yarn_git_sources)
    assert outside_source_parser("requirements-dev.txt") is None
    assert outside_source_parser("go.sum") is None
