#!/usr/bin/env bash
# What the check tests share: failing with the output they checked, and
# expecting that output to name things. Sourced by test.sh and test-cpp.sh.

# The output of the run a test checks, shown when the test fails.
output=""

fail() {
  echo "$output"
  echo "$1" >&2
  exit 1
}

expect_names() {
  for name in "$@"; do
    grep -qF -- "$name" <<< "$output" || fail "expected the output to name $name"
  done
}

# Commits what the scratch project holds as the pull request's base, so the
# dependencies added after it are new, and points the dependency check at it
# through the event GitHub Actions would provide, written to the given file.
commit_base() {
  local event="$1"
  git add -A
  git -c user.name=fixture -c user.email=fixture@example.test commit -qm base
  printf '{"pull_request": {"base": {"sha": "%s"}}}\n' "$(git rev-parse HEAD)" > "$event"
  export GITHUB_EVENT_PATH="$event"
}
