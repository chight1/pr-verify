"""Keeps the findings a check reported in the code a pull request changes.

A finding is a line of the check's output that names a tracked file: with a line
number, as path:12 or path(12,5); with a range of lines, as jscpd and the hunks
of a formatter's diff give; or as the whole file. One on a changed line counts,
and so does one about a whole file the pull request changes. A size or
complexity finding is about a function, so it counts when the pull request
touches any line of that function.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from changed_lines import ChangedCode, Function, functions

if TYPE_CHECKING:
    from collections.abc import Iterable

LOCATION = re.compile(
    r"(?P<path>[\w@.+/-]+)"
    r"(?::(?P<line>\d+)|\((?P<call_line>\d+),\d+\)"
    r"|\s\[(?P<start>\d+):\d+ - (?P<end>\d+):\d+\])?"
)
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+")
# How a diff names the file its hunks belong to: +++ path, and git's +++ b/path.
DIFF_FILE = re.compile(r"^\+\+\+ (?:b/)?(\S+)")
ANSI_COLOR = re.compile(r"\x1b\[[0-9;]*m")
# complexipy's plain output: the file, the function and its score.
COMPLEXIPY_LINE = re.compile(r"^(?P<path>\S+) (?P<function>\S+) \d+$")
# The checks whose every finding is about a function's size or complexity,
# and the rules of the other linters that are.
SIZE_CHECKS = frozenset({"lizard", "complexipy"})
SIZE_RULES = re.compile(
    r"\b(C901|PLR0913|PLR0915|gocognit|gocyclo|funlen|nestif|argument-limit"
    r"|complexity|max-lines-per-function|max-params|max-depth|max-statements"
    r"|readability-function-size|readability-function-cognitive-complexity)\b"
)


@dataclass(frozen=True)
class Mention:
    path: str
    # None when the finding is about the file as a whole.
    lines: range | None


@dataclass
class Report:
    kept: list[str]
    left_out: int
    names_a_file: bool


class FindingFilter:
    def __init__(
        self, check: str, code: ChangedCode, tracked: set[str], root: str
    ) -> None:
        self.check = check
        self.code = code
        self.tracked = tracked
        self.root = f"{root}/"
        self.diff_file: str | None = None
        self.functions: dict[str, list[Function]] | None = None

    def mentions(self, line: str) -> list[Mention]:
        """The tracked files a line of output names, and where in each."""
        found: list[Mention] = []
        for match in LOCATION.finditer(line):
            path = match.group("path").removeprefix("./")
            if path not in self.tracked:
                continue
            found.append(Mention(path, mentioned_lines(match)))
        hunk = HUNK.match(line)
        if hunk is not None and self.diff_file is not None:
            start, count = int(hunk.group(1)), int(hunk.group(2) or "1")
            found.append(Mention(self.diff_file, range(start, start + max(count, 1))))
        return found

    def diff_header(self, line: str) -> bool:
        """Whether a line heads a formatter's diff rather than reporting
        anything, noting which file the hunks after it belong to: the one a +++
        line names, or for djLint, which prints no +++ line, the path alone."""
        diff_file = DIFF_FILE.match(line)
        if diff_file is not None:
            self.diff_file = diff_file.group(1)
            return True
        if self.check == "djLint" and line.strip() in self.tracked:
            self.diff_file = line.strip()
            return True
        return line.startswith(("--- ", "diff "))

    def file_functions(self, path: str) -> list[Function]:
        """The functions lizard finds in a changed file, read once for them all."""
        if self.functions is None:
            self.functions = functions(sorted(self.code.lines))
        return self.functions.get(path, [])

    def function_lines(self, path: str, line: int) -> range | None:
        """The lines of the function a line falls in."""
        for function in self.file_functions(path):
            if function.start <= line <= function.end:
                return range(function.start, function.end + 1)
        return None

    def named_function(self, path: str, name: str) -> range | None:
        """The lines of a function complexipy names, as Class::method or alone."""
        short_name = name.rsplit("::", 1)[-1]
        for function in self.file_functions(path):
            if function.name.rsplit(".", 1)[-1] == short_name:
                return range(function.start, function.end + 1)
        return None

    def counts(self, mention: Mention, *, size_finding: bool) -> bool:
        """Whether a finding is in code the pull request changes."""
        changed = self.code.lines.get(mention.path)
        if changed is None:
            return False
        if mention.lines is None:
            return True
        if any(line in changed for line in mention.lines):
            return True
        if not size_finding:
            return False
        function = self.function_lines(mention.path, mention.lines.start)
        touched = self.code.touched.get(mention.path, set())
        return function is not None and any(line in touched for line in function)

    def complexipy_mentions(self, line: str) -> list[Mention] | None:
        """complexipy names a function without its line, so it is found by name."""
        match = COMPLEXIPY_LINE.match(line)
        if self.check != "complexipy" or match is None:
            return None
        path = match.group("path")
        if path not in self.tracked:
            return []
        return [Mention(path, self.named_function(path, match.group("function")))]

    def report(self, output: Iterable[str]) -> Report:
        report = Report(kept=[], left_out=0, names_a_file=False)
        for raw_line in output:
            line = ANSI_COLOR.sub("", raw_line).replace(self.root, "")
            if self.diff_header(line):
                report.names_a_file = True
                continue
            mentions = self.complexipy_mentions(line)
            if mentions is None:
                mentions = self.mentions(line)
            if not mentions:
                continue
            report.names_a_file = True
            # A note explains a finding; it is not one.
            if ": note:" in line:
                continue
            size_finding = (
                self.check in SIZE_CHECKS or SIZE_RULES.search(line) is not None
            )
            if any(
                self.counts(mention, size_finding=size_finding) for mention in mentions
            ):
                report.kept.append(line)
            else:
                report.left_out += 1
        return report


def mentioned_lines(match: re.Match[str]) -> range | None:
    """The lines a location names: one line, a range, or the whole file."""
    single = match.group("line") or match.group("call_line")
    if single is not None:
        return range(int(single), int(single) + 1)
    if match.group("start") is not None:
        return range(int(match.group("start")), int(match.group("end")) + 1)
    return None
