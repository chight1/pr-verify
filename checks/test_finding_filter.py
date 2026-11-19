from changed_lines import ChangedCode, Function
from finding_filter import FindingFilter

ROOT = "/home/runner/work/app/app"
TRACKED = {"src/app.py", "src/old.py", "src/order.ts", "src/first.js", "page.html"}


def changed_filter(check: str = "ruff check") -> FindingFilter:
    """src/app.py changes on lines 10 and 11, after a removal following line 30;
    page.html and src/first.js change on line 3."""
    code = ChangedCode(
        lines={"src/app.py": {10, 11}, "page.html": {3}, "src/first.js": {3}},
        touched={"src/app.py": {10, 11, 30}, "page.html": {3}, "src/first.js": {3}},
    )
    finding_filter = FindingFilter(check, code, TRACKED, ROOT)
    finding_filter.functions = {
        "src/app.py": [Function("tangle", 5, 20), Function("Order.total", 25, 40)]
    }
    return finding_filter


def test_findings_on_changed_lines_are_kept_and_the_rest_left_out() -> None:
    report = changed_filter().report(
        [
            "src/app.py:10:5: E501 Line too long",
            f"{ROOT}/src/app.py:12:1 - error: Type unknown",
            "src/old.py:3:1: F401 unused import",
        ]
    )
    assert report.kept == ["src/app.py:10:5: E501 Line too long"]
    assert report.left_out == 2


def test_typescript_locations_and_whole_files_are_read() -> None:
    report = changed_filter("tsc").report(
        [
            "src/order.ts(3,5): error TS7006: Parameter implicitly has an any type.",
            "src/app.py: DEP002 'requests' defined as a dependency but not used",
        ]
    )
    assert report.kept == [
        "src/app.py: DEP002 'requests' defined as a dependency but not used"
    ]


def test_a_size_finding_counts_when_its_function_is_touched() -> None:
    report = changed_filter().report(
        [
            "src/app.py:5:5: C901 `tangle` is too complex (12 > 10)",
            "src/app.py:25:5: PLR0915 Too many statements (60 > 30)",
            "src/app.py:25:9: E741 Ambiguous variable name",
        ]
    )
    assert report.kept == [
        "src/app.py:5:5: C901 `tangle` is too complex (12 > 10)",
        "src/app.py:25:5: PLR0915 Too many statements (60 > 30)",
    ]


def test_complexipy_findings_are_matched_to_their_function_by_name() -> None:
    report = changed_filter("complexipy").report(
        ["src/app.py Order::total 22", "src/old.py tangle 30"]
    )
    assert report.kept == ["src/app.py Order::total 22"]


def test_a_formatter_diff_counts_only_hunks_over_changed_lines() -> None:
    diff = [
        "--- src/app.py",
        "+++ src/app.py",
        "@@ -2,1 +2,1 @@",
        "-x=1",
        "+x = 1",
        "@@ -11,1 +11,1 @@",
        "-y=2",
        "+y = 2",
    ]
    report = changed_filter("ruff format").report(diff)
    assert report.kept == ["@@ -11,1 +11,1 @@"]
    assert report.names_a_file


def test_djlint_names_its_file_on_a_line_of_its_own() -> None:
    report = changed_filter("djLint").report(["page.html", "─────", "@@ -3,2 +3,4 @@"])
    assert report.kept == ["@@ -3,2 +3,4 @@"]


def test_a_copied_block_counts_when_either_copy_is_changed_code() -> None:
    report = changed_filter("jscpd").report(
        [
            " - src/first.js [1:1 - 11:2] (10 lines, 80 tokens)",
            "   src/old.py [1:1 - 11:2]",
        ]
    )
    assert report.kept == [" - src/first.js [1:1 - 11:2] (10 lines, 80 tokens)"]


def test_notes_and_output_naming_no_file_are_not_findings() -> None:
    report = changed_filter("clang-tidy").report(
        [
            "src/app.py:10:1: note: 52 lines including whitespace",
            "Error: no config found",
        ]
    )
    assert report.kept == []
    assert report.names_a_file
    assert not changed_filter().report(["Error: no config found"]).names_a_file
