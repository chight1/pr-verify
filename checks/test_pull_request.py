import json
import subprocess
from pathlib import Path

import pytest
from pull_request import base_sha, first_parent

AUTHOR = {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def run_git(repository: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def commit(repository: Path, message: str) -> str:
    run_git(repository, "commit", "-q", "--allow-empty", "-m", message)
    return run_git(repository, "rev-parse", "HEAD")


@pytest.fixture
def repository(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name, value in AUTHOR.items():
        monkeypatch.setenv(name, value)
    origin = tmp_path / "origin"
    origin.mkdir()
    run_git(origin, "init", "-q")
    return origin


def test_the_canary_compares_with_the_commit_before_the_newest(
    repository: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    earlier = commit(repository, "earlier")
    commit(repository, "newest")
    monkeypatch.chdir(repository)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "schedule")
    assert base_sha() == earlier


def test_a_shallow_checkout_still_names_the_parent(
    repository: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    earlier = commit(repository, "earlier")
    commit(repository, "newest")
    checkout = tmp_path / "checkout"
    run_git(tmp_path, "clone", "-q", "--depth", "1", repository.as_uri(), str(checkout))
    monkeypatch.chdir(checkout)
    assert first_parent("HEAD") == earlier


def test_the_first_commit_has_nothing_to_compare_with(
    repository: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commit(repository, "first")
    monkeypatch.chdir(repository)
    assert first_parent("HEAD") is None


def test_a_pull_request_compares_with_its_base(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    event = tmp_path / "event.json"
    pull_request = {"pull_request": {"base": {"sha": "abc123"}}}
    event.write_text(json.dumps(pull_request), encoding="utf-8")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    assert base_sha() == "abc123"
