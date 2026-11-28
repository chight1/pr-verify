"""The code a pull request changes, for a gate set to check only that.

Usage:
  changed_code.py base                  the commit compared with: the pull
                                        request's base, or the canary's
  changed_code.py files PATH...         the given paths the pull request changes
  changed_code.py filter CHECK STATUS   a check's output, read from stdin, cut to
                                        the findings in changed code, given the
                                        check's name and exit status
"""

from __future__ import annotations

import sys
from pathlib import Path

from changed_lines import DiffError, changed_code
from finding_filter import FindingFilter
from pull_request import base_sha, fetch_commit, git

USAGE_ERROR = 2


def pull_request_base() -> str:
    """The base commit, fetched when the checkout lacks it, as it does when the
    online checks list the changed files: they run before anything else."""
    base = base_sha()
    if base is None:
        message = (
            "gate-scope: changes needs a commit to compare with: a pull "
            "request's base, or on the weekly canary, the commit before the newest."
        )
        raise SystemExit(message)
    fetch_commit(base)
    return base


def print_changed(paths: list[str]) -> int:
    changed = changed_code(pull_request_base()).lines
    for path in paths:
        if path in changed:
            sys.stdout.write(f"{path}\n")
    return 0


def filter_output(check: str, status: int) -> int:
    """Prints the findings in changed code and fails when there are any. A
    check that failed without naming any file failed to run, so it still fails,
    with all it printed."""
    output = sys.stdin.read()
    if status == 0:
        sys.stdout.write(output)
        return 0
    tracked = set(git("ls-files").stdout.splitlines())
    code = changed_code(pull_request_base())
    finding_filter = FindingFilter(check, code, tracked, str(Path.cwd()))
    report = finding_filter.report(output.splitlines())
    if not report.names_a_file:
        sys.stdout.write(output)
        return status
    for line in report.kept:
        sys.stdout.write(f"{line}\n")
    if report.left_out:
        sys.stdout.write(
            f"{report.left_out} findings outside the code this pull request "
            "changes were left out.\n"
        )
    if report.kept:
        return 1
    return 0


def main(arguments: list[str]) -> int:
    match arguments:
        case ["base"]:
            sys.stdout.write(f"{pull_request_base()}\n")
            return 0
        case ["files", *paths]:
            return print_changed(paths)
        case ["filter", check, status] if status.lstrip("-").isdigit():
            return filter_output(check, int(status))
        case _:
            sys.stderr.write(__doc__ or "")
            return USAGE_ERROR


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except DiffError as error:
        sys.stderr.write(f"{error}\n")
        sys.exit(1)
