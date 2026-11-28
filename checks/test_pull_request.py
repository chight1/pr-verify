import json
import os
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import chdir, contextmanager
from pathlib import Path

from pull_request import base_sha, first_parent

AUTHOR = {
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


@contextmanager
def environment(**variables: str) -> Iterator[None]:
    """Sets the variables for the length of a test, then restores them."""
    saved = {name: os.environ.get(name) for name in variables}
    os.environ.update(variables)
    try:
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def run_git(repository: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *args],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, **AUTHOR},
    )
    return completed.stdout.strip()


def commit(repository: Path, message: str) -> str:
    run_git(repository, "commit", "-q", "--allow-empty", "-m", message)
    return run_git(repository, "rev-parse", "HEAD")


def new_repository(parent: Path) -> Path:
    repository = parent / "origin"
    repository.mkdir()
    run_git(repository, "init", "-q")
    return repository


def test_the_canary_compares_with_the_commit_before_the_newest() -> None:
    with tempfile.TemporaryDirectory() as scratch:
        repository = new_repository(Path(scratch))
        earlier = commit(repository, "earlier")
        commit(repository, "newest")
        with chdir(repository), environment(GITHUB_EVENT_NAME="schedule"):
            assert base_sha() == earlier


def test_a_shallow_checkout_still_names_the_parent() -> None:
    with tempfile.TemporaryDirectory() as scratch:
        repository = new_repository(Path(scratch))
        earlier = commit(repository, "earlier")
        commit(repository, "newest")
        checkout = Path(scratch) / "checkout"
        source = repository.as_uri()
        run_git(Path(scratch), "clone", "-q", "--depth", "1", source, str(checkout))
        with chdir(checkout):
            assert first_parent("HEAD") == earlier


def test_the_first_commit_has_nothing_to_compare_with() -> None:
    with tempfile.TemporaryDirectory() as scratch:
        repository = new_repository(Path(scratch))
        commit(repository, "first")
        with chdir(repository):
            assert first_parent("HEAD") is None


def test_a_pull_request_compares_with_its_base() -> None:
    with tempfile.TemporaryDirectory() as scratch:
        event = Path(scratch) / "event.json"
        pull_request = {"pull_request": {"base": {"sha": "abc123"}}}
        event.write_text(json.dumps(pull_request), encoding="utf-8")
        with environment(
            GITHUB_EVENT_NAME="pull_request", GITHUB_EVENT_PATH=str(event)
        ):
            assert base_sha() == "abc123"
