"""Which of the given files the compile commands list, as files CMake builds.

Usage: compiled_files.py COMPILE_COMMANDS PATH...
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def compiled(commands_file: Path) -> set[Path]:
    """Every file the compile commands list. A file's path is relative to its
    entry's directory unless it is absolute."""
    entries: list[dict[str, Any]] = json.loads(
        commands_file.read_text(encoding="utf-8")
    )
    return {(Path(entry["directory"]) / entry["file"]).resolve() for entry in entries}


def main(arguments: list[str]) -> int:
    commands_file, *paths = arguments
    listed = compiled(Path(commands_file))
    for path in paths:
        if Path(path).resolve() in listed:
            sys.stdout.write(f"{path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
