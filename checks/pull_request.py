"""The commit a gate compares with: a pull request's base commit, read from the
event GitHub Actions provides, or on the weekly canary, the commit before the
newest one on the branch. Fetched when the checkout lacks it.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
from pathlib import Path
from typing import Any


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)


def base_sha() -> str | None:
    """The commit to compare with, or None for an event that has none."""
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
        return first_parent("HEAD")
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        return None
    event: dict[str, Any] = json.loads(Path(event_path).read_text(encoding="utf-8"))
    return event.get("pull_request", {}).get("base", {}).get("sha")


def first_parent(commit: str) -> str | None:
    """Read from the commit itself, which names its parents even in a shallow
    checkout that lacks them. For a merged pull request, the first parent is
    the branch before the merge. None for a commit with no parent."""
    header = git("cat-file", "commit", commit).stdout.split("\n\n", 1)[0]
    for line in header.splitlines():
        if line.startswith("parent "):
            return line.removeprefix("parent ")
    return None


def fetch_commit(sha: str) -> None:
    """The checkout is one commit deep and holds no credentials, so the base
    commit is fetched with the workflow's token when it is not already here.
    The online checks fetch it, so the steps after them, which have no token,
    find it in the checkout."""
    if git("cat-file", "-e", f"{sha}^{{commit}}").returncode == 0:
        return
    token = os.environ.get("GH_TOKEN", "")
    credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    header = f"http.extraHeader=Authorization: basic {credentials}"
    git("-c", header, "fetch", "--depth", "1", "--no-tags", "origin", sha)
