# shellcheck shell=bash
# What the check scripts share: the files they check, and running each check so
# that one failure never stops the rest. Sourced, never run.

failed=()

# Tracked files a person writes: not lockfiles, minified bundles, source maps,
# or files .gitattributes marks linguist-generated. The same files the review reads.
written_files() {
  git ls-files -z \
    | git check-attr -z --stdin linguist-generated \
    | while IFS= read -r -d '' path && IFS= read -r -d '' _ && IFS= read -r -d '' value; do
      [ "$value" = set ] || [ "$value" = true ] || printf '%s\n' "$path"
    done \
    | grep -vE '(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|packages\.lock\.json|composer\.lock)$|\.min\.(js|css)$|\.map$'
}

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

# Lists the failed checks under a heading in the job summary and fails the script.
finish() {
  local heading="$1"
  [ ${#failed[@]} -eq 0 ] && exit 0
  {
    echo "### $heading"
    echo
    printf -- '- %s failed\n' "${failed[@]}"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
}
