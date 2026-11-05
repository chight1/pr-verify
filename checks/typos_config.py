"""Writes the gate's config for typos: its own dictionary, plus the words a
project's typos config accepts, such as the names in its license.

Only a word that maps to itself is kept, so a project can teach typos a word
but cannot exclude a file, ignore a pattern or turn a check off.

Usage: typos_config.py OUTPUT
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path
from typing import Any

CONFIG_FILES = ("typos.toml", "_typos.toml", ".typos.toml")


def accepted_words(config: dict[str, Any]) -> set[str]:
    words: dict[str, Any] = config.get("default", {}).get("extend-words", {})
    return {word for word, correction in words.items() if word == correction}


def project_words() -> set[str]:
    words: set[str] = set()
    for name in CONFIG_FILES:
        path = Path(name)
        if path.is_file():
            config = tomllib.loads(path.read_text(encoding="utf-8"))
            words |= accepted_words(config)
    return words


def accepting_entry(word: str) -> str:
    """A config line that maps the word to itself. A TOML string escapes like JSON."""
    quoted = json.dumps(word)
    return f"{quoted} = {quoted}"


def main(output: str) -> int:
    entries = [accepting_entry(word) for word in sorted(project_words())]
    config = "\n".join(["[default.extend-words]", *entries])
    Path(output).write_text(f"{config}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
