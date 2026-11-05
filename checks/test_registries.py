from registries import fixed_versions


def fix(name: str, ecosystem: str, version: str) -> dict[str, object]:
    events = [{"introduced": "0"}, {"fixed": version}]
    return {
        "package": {"name": name, "ecosystem": ecosystem},
        "ranges": [{"events": events}],
    }


def test_fixed_versions_are_read_for_the_named_package_only() -> None:
    advisory = {
        "affected": [
            fix("lodash", "npm", "4.17.21"),
            fix("lodash-es", "npm", "4.17.22"),
        ]
    }
    assert fixed_versions(advisory, "npm", "lodash") == {"4.17.21"}


def test_python_package_names_match_as_pypi_compares_them() -> None:
    advisory = {"affected": [fix("PyYAML", "PyPI", "5.4")]}
    assert fixed_versions(advisory, "pypi", "pyyaml") == {"5.4"}


def test_go_fixes_get_their_leading_v() -> None:
    advisory = {"affected": [fix("golang.org/x/crypto", "Go", "0.31.0")]}
    assert fixed_versions(advisory, "go", "golang.org/x/crypto") == {"v0.31.0"}
