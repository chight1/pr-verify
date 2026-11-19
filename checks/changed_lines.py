"""Which lines of which files a pull request changes, from git's diff of its base
commit and the checkout, and where each function in a file starts and ends,
from lizard, which reads every language the gate checks.
"""

from __future__ import annotations

import csv
import re
import subprocess
from dataclasses import dataclass

from pull_request import git

# A hunk of a diff with no context: where its lines start on the new side, and
# how many there are. A count of 0 means lines were only removed, after the
# start line.
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
NEW_SIDE = "+++ "
# The escapes git writes in a quoted path, and what each stands for.
QUOTED_PATH_ESCAPE = re.compile(r'\\(["\\tn])')
ESCAPED = {'"': '"', "\\": "\\", "t": "\t", "n": "\n"}
LIZARD = "lizard==1.26.0"
# lizard's CSV columns: NLOC, CCN, tokens, parameters, length, location, file,
# function, long name, start line, end line.
LIZARD_COLUMNS = 11


@dataclass
class ChangedCode:
    # The lines each changed file has that the base commit did not.
    lines: dict[str, set[int]]
    # Those lines, and the line after which lines were removed, since a removal
    # touches the function it was made in.
    touched: dict[str, set[int]]

    def add_hunk(self, path: str, start: int, count: int) -> None:
        self.lines.setdefault(path, set()).update(range(start, start + count))
        self.touched.setdefault(path, set()).update(range(start, start + max(count, 1)))


@dataclass(frozen=True)
class Function:
    name: str
    start: int
    end: int


def new_side_path(line: str) -> str | None:
    """The path a diff's +++ line names: b/ and the path, with the tab git
    writes after a path that holds a space left off, and quoted, with escapes,
    when the path holds a quote, a backslash or a control character. A deleted
    file's new side is /dev/null, which names no path."""
    name = line.removeprefix(NEW_SIDE).split("\t", 1)[0]
    if len(name) > 1 and name.startswith('"') and name.endswith('"'):
        name = QUOTED_PATH_ESCAPE.sub(
            lambda escape: ESCAPED[escape.group(1)], name[1:-1]
        )
    if not name.startswith("b/"):
        return None
    return name.removeprefix("b/")


class DiffError(Exception):
    """git could not compare the checkout with the base commit. Read as no
    changes, it would pass every check, so it fails instead."""


def changed_code(base: str) -> ChangedCode:
    """What the checkout changes since the base commit. A deleted file has no
    lines left to change."""
    diff_options = ["--unified=0", "--no-color", "--no-ext-diff"]
    compared = git("-c", "core.quotePath=false", "diff", *diff_options, base, "HEAD")
    if compared.returncode != 0:
        message = f"Could not compare with the base commit {base}: {compared.stderr}"
        raise DiffError(message)
    diff = compared.stdout
    code = ChangedCode(lines={}, touched={})
    path: str | None = None
    for line in diff.splitlines():
        if line.startswith(NEW_SIDE):
            path = new_side_path(line)
            continue
        hunk = HUNK.match(line)
        if hunk is not None and path is not None:
            code.add_hunk(path, int(hunk.group(1)), int(hunk.group(2) or "1"))
    return code


def lizard_function(row: list[str]) -> tuple[str, Function] | None:
    """A row of lizard's CSV as the file and the function it describes."""
    if len(row) < LIZARD_COLUMNS or not row[9].isdigit() or not row[10].isdigit():
        return None
    return row[6], Function(row[7], int(row[9]), int(row[10]))


def functions(paths: list[str]) -> dict[str, list[Function]]:
    """Every function lizard finds in the given files, by file."""
    if not paths:
        return {}
    listing = subprocess.run(
        ["pipx", "run", LIZARD, "--csv", *paths],
        capture_output=True,
        text=True,
        check=False,
    )
    found: dict[str, list[Function]] = {}
    for row in csv.reader(listing.stdout.splitlines()):
        described = lizard_function(row)
        if described is not None:
            path, function = described
            found.setdefault(path, []).append(function)
    return found
