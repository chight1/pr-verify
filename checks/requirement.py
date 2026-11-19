"""A dependency a manifest names, as every manifest reader returns it, and the
spelling PyPI compares names in.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Requirement:
    """A dependency a manifest names: a registry package, unless it comes from
    git or a URL, whose age no registry can tell."""

    name: str
    outside_source: str | None = None


def normalized(name: str) -> str:
    """A Python package name as PyPI compares it."""
    return re.sub(r"[-_.]+", "-", name).lower()
