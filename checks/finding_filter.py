"""Keeps the findings a check reported in the code a pull request changes.

A finding is a line of the check's output that names a tracked file: with a line
number, as path:12 or path(12,5); with a range of lines, as jscpd gives; or as
the whole file. One on a changed line counts, and so does one about a whole file
the pull request changes. A size or complexity finding is about a function, so
it counts when the pull request touches any line of that function. A
formatter's diff counts when a hunk changes a line the pull request changed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from changed_lines import ChangedCode, Function, functions
from formatter_diff import hunks

if TYPE_CHECKING:
    from collections.abc import Collection, Iterable

# Where in a file a finding is, written right after the file's path: :12,
# (12,5), or jscpd's [12:1 - 20:2]. Nothing there means the whole file.
AFTER_PATH = re.compile(
    r":(?P<line>\d+)|\((?P<call_line>\d+),\d+\)"
    r"|\s\[(?P<start>\d+):\d+ - (?P<end>\d+):\d+\]"
)
# The characters around a path in a line of output. A changed file's path is
# searched for whole, since it can hold brackets, parentheses or spaces, as a
# route in a web framework can.
BEFORE_A_PATH = frozenset(" \t\"'`=(<[,")
AFTER_A_PATH = frozenset(" \t:,()\"'`>[]")
# Something shaped like a path, to tell whether output names any tracked file.
PATH_LIKE = re.compile(r"[\w@.+/-]+")
# A ./ before a path, which the files' own paths do not have.
DOT_SLASH = re.compile(r"(^|[\s\"'(=])\./")
ANSI_COLOR = re.compile(r"\x1b\[[0-9;]*m")
# complexipy's plain output: the file, the function and its score.
COMPLEXIPY_LINE = re.compile(r"^(?P<path>.+) (?P<function>\S+) \d+$")
# The checks whose every finding is about a function's size or complexity,
# and the rules of the other linters that are.
SIZE_CHECKS = frozenset({"lizard", "complexipy"})
SIZE_RULES = re.compile(
    r"\b(C901|PLR0913|PLR0915|gocognit|gocyclo|funlen|nestif|argument-limit"
    r"|complexity|max-lines-per-function|max-params|max-depth|max-statements"
    r"|readability-function-size|readability-function-cognitive-complexity)\b"
)
# The formatters that print a diff of each file they would change.
DIFF_CHECKS = frozenset({"ruff format", "gofmt", "Prettier", "djLint"})


@dataclass(frozen=True)
class Mention:
    path: str
    # None when the finding is about the file as a whole.
    lines: Collection[int] | None


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
        self.functions: dict[str, list[Function]] | None = None

    def mentions(self, line: str) -> list[Mention]:
        """The changed files a line of output names, and where in each."""
        found: list[Mention] = []
        for path in self.code.lines:
            for start in path_starts(line, path):
                following = AFTER_PATH.match(line, start + len(path))
                found.append(Mention(path, mentioned_lines(following)))
        return found

    def header(self, line: str) -> bool:
        """Whether a line is a file's path on its own, as pyright prints before
        that file's findings. Only knip lists a whole file as a finding that
        way, an unused one."""
        return line.strip() in self.tracked and self.check != "knip"

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

    def named_functions(self, path: str, name: str) -> list[range]:
        """The lines of each function complexipy could mean by a name such as
        Class::method: the one lizard names Class.method, or failing that,
        every function with the method's name, since several classes can each
        have one. The finding counts if any of them is touched."""
        full_name = name.replace("::", ".")
        short_name = full_name.rsplit(".", 1)[-1]
        functions_in_file = self.file_functions(path)
        exact = [
            function for function in functions_in_file if function.name == full_name
        ]
        same_name = [
            function
            for function in functions_in_file
            if function.name.rsplit(".", 1)[-1] == short_name
        ]
        return [
            range(function.start, function.end + 1) for function in exact or same_name
        ]

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
        function = self.function_lines(mention.path, min(mention.lines))
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
        functions_named = self.named_functions(path, match.group("function"))
        if not functions_named:
            return [Mention(path, None)]
        return [Mention(path, lines) for lines in functions_named]

    def line_mentions(self, line: str) -> list[Mention]:
        mentions = self.complexipy_mentions(line)
        if mentions is None:
            return self.mentions(line)
        return mentions

    def explains(self, line: str) -> bool:
        """Whether a line explains a finding rather than reporting one, as a
        clang-tidy note does. shellcheck's gcc format prints its info and style
        findings as notes too, and those are findings."""
        return self.check == "clang-tidy" and ": note:" in line

    def in_changed_code(self, line: str, mentions: list[Mention]) -> bool:
        size_finding = self.check in SIZE_CHECKS or SIZE_RULES.search(line) is not None
        return any(
            self.counts(mention, size_finding=size_finding) for mention in mentions
        )

    def names_a_tracked_file(self, line: str) -> bool:
        """Whether a line names a tracked file, changed or not, as a check's
        findings do and its errors about itself do not."""
        return any(token in self.tracked for token in PATH_LIKE.findall(line))

    def cleaned(self, output: Iterable[str]) -> list[str]:
        """The output without color, and with paths relative to the project."""
        lines: list[str] = []
        for raw_line in output:
            line = ANSI_COLOR.sub("", raw_line).replace(self.root, "")
            lines.append(DOT_SLASH.sub(r"\1", line))
        return lines

    def diff_report(self, output: list[str]) -> Report:
        """A formatter's hunks that change a line the pull request changed."""
        report = Report(kept=[], left_out=0, names_a_file=False)
        for hunk in hunks(output, self.tracked):
            report.names_a_file = True
            if hunk.lines & self.code.lines.get(hunk.path, set()):
                report.kept.append(f"{hunk.path}: {hunk.header}")
            else:
                report.left_out += 1
        return report

    def report(self, output: Iterable[str]) -> Report:
        lines = self.cleaned(output)
        if self.check in DIFF_CHECKS:
            return self.diff_report(lines)
        report = Report(kept=[], left_out=0, names_a_file=False)
        for line in lines:
            if self.header(line):
                report.names_a_file = True
                continue
            mentions = self.line_mentions(line)
            names_a_file = bool(mentions) or self.names_a_tracked_file(line)
            report.names_a_file = report.names_a_file or names_a_file
            if not names_a_file or self.explains(line):
                continue
            if mentions and self.in_changed_code(line, mentions):
                report.kept.append(line)
            else:
                report.left_out += 1
        return report


def path_starts(line: str, path: str) -> list[int]:
    """Where a path appears in a line whole, not as part of a longer path."""
    starts: list[int] = []
    start = line.find(path)
    while start != -1:
        end = start + len(path)
        before_ok = start == 0 or line[start - 1] in BEFORE_A_PATH
        after_ok = end == len(line) or line[end] in AFTER_A_PATH
        if before_ok and after_ok:
            starts.append(start)
        start = line.find(path, start + 1)
    return starts


def mentioned_lines(match: re.Match[str] | None) -> range | None:
    """The lines a location names: one line, a range, or the whole file."""
    if match is None:
        return None
    single = match.group("line") or match.group("call_line")
    if single is not None:
        return range(int(single), int(single) + 1)
    if match.group("start") is not None:
        return range(int(match.group("start")), int(match.group("end")) + 1)
    return None
