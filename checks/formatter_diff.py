"""The hunks of the diffs formatters print, and which lines of the file each one
changes. A hunk shows unchanged lines around its change for context, and only
the lines it removes, or inserts next to, are the ones the formatter would
change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@")
# How a diff names the file its hunks belong to: +++ path, and git's +++ b/path,
# with any timestamp after a tab left off.
NEW_FILE = re.compile(r"^\+\+\+ (?:b/)?([^\t]+)")


@dataclass
class Hunk:
    path: str
    header: str
    # The lines of the file as it is that the formatter would change.
    lines: set[int]
    # The line of the file the next line of the hunk's body is about.
    next_line: int
    # How many lines of the file as it is, and as formatted, the body has left.
    old_left: int
    new_left: int

    def read(self, body_line: str) -> None:
        """Takes one line of the body. An inserted line changes the lines on
        either side of where it goes."""
        if body_line.startswith("-"):
            self.lines.add(self.next_line)
            self.next_line += 1
            self.old_left -= 1
        elif body_line.startswith("+"):
            self.lines.update({self.next_line - 1, self.next_line})
            self.new_left -= 1
        else:
            self.next_line += 1
            self.old_left -= 1
            self.new_left -= 1

    @property
    def done(self) -> bool:
        return self.old_left <= 0 and self.new_left <= 0


def opened_hunk(line: str, path: str) -> Hunk | None:
    header = HUNK.match(line)
    if header is None:
        return None
    start = int(header.group(1))
    old_count = int(header.group(2) or "1")
    new_count = int(header.group(3) or "1")
    return Hunk(path, line, set(), start, old_count, new_count)


def hunks(output: Iterable[str], tracked: set[str]) -> list[Hunk]:
    """Every hunk in a formatter's output. Each hunk's body is as long as its
    header says, so a removed line that starts with --- is not read as the next
    file's header. djLint prints a file's path on a line of its own instead of
    a +++ line."""
    found: list[Hunk] = []
    path: str | None = None
    hunk: Hunk | None = None
    for line in output:
        if hunk is not None and not hunk.done:
            hunk.read(line)
            continue
        new_file = NEW_FILE.match(line)
        if new_file is not None:
            path = new_file.group(1)
        elif line.strip() in tracked:
            path = line.strip()
        elif path is not None:
            hunk = opened_hunk(line, path)
            if hunk is not None:
                found.append(hunk)
    return found
