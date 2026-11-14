#!/usr/bin/env bash
# The gate's code-quality checks, run on the project in the working directory,
# or with "online", the checks that need the workflow's token. Every tool runs
# with settings that ship here, so a project's own config and ignore files have
# no effect on the result. Each check runs even when an earlier one fails, and
# the script fails at the end if any did.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=()
# Configs written at the project root, since pyright and TypeScript resolve the
# project's imports from the config's own directory. Untracked, and removed on exit.
written=()
trap 'rm -f "${written[@]}"' EXIT

# Which files are checked, the pinned tools that check them, and the checks,
# one file for each kind.
# shellcheck source=checks/checked-files.sh
source "$here/checked-files.sh"
# shellcheck source=checks/tool-downloads.sh
source "$here/tool-downloads.sh"
# shellcheck source=checks/formatting.sh
source "$here/formatting.sh"
# shellcheck source=checks/lint.sh
source "$here/lint.sh"
# shellcheck source=checks/size.sh
source "$here/size.sh"
# shellcheck source=checks/dead-code.sh
source "$here/dead-code.sh"
# shellcheck source=checks/file-hygiene.sh
source "$here/file-hygiene.sh"

# Runs one tool in a collapsible log group and records it if it fails.
run() {
  local name="$1"
  shift
  echo "::group::$name"
  "$@"
  local status=$?
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    failed+=("$name")
    echo "::error title=$name::$name failed. The log group above shows what to fix."
  fi
}

# Marks a config a check wrote at the project root, so it is removed on exit.
remember_written() {
  written+=("$1")
}

# Lists the failed checks under a heading in the job summary, and fails if any
# did. It returns rather than exits, since shellcheck judges the checks run()
# calls by what the script has defined when it reaches its end.
summarize() {
  local heading="$1"
  [ ${#failed[@]} -eq 0 ] && return 0
  {
    echo "### $heading"
    echo
    printf -- '- %s failed\n' "${failed[@]}"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  return 1
}

mapfile -t files < <(written_files)

# With "online", only the checks that look things up on GitHub with the
# workflow's token, and on package registries. The gate runs them in a step of
# their own before its install step, the first to run the project's code, so no
# process the project starts is alive to read the token.
if [ "${1:-}" = online ]; then
  mapfile -t workflows < <(workflow_files "${files[@]}")
  mapfile -t actions < <(action_files "${files[@]}")
  # zizmor's online audits look up the actions a workflow uses.
  if any "${workflows[@]}" "${actions[@]}"; then
    run "zizmor" pipx run zizmor==1.31.1 --config "$here/zizmor.yml" --no-ignores --no-progress \
      "${workflows[@]}" "${actions[@]}"
  fi
  # A dependency the pull request adds that its registry lacks or has had under
  # 30 days, and a locked version under 7 days old that no advisory names as a
  # fix. The token fetches the pull request's base commit to compare with.
  run "new dependencies" python3 "$here/check_new_dependencies.py"
  summarize "Online checks"
  exit
fi

formatting_checks "${files[@]}"
lint_checks "${files[@]}"
size_checks "${files[@]}"
dead_code_checks "${files[@]}"
file_hygiene_checks "${files[@]}"

summarize "Code quality"
