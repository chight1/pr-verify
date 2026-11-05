#!/usr/bin/env bash
# The gate's code-quality checks, run on the project in the working directory.
# Every tool runs with settings that ship here, so a project's own config and
# ignore files have no effect on the result. Each check runs even when an
# earlier one fails, and the script fails at the end if any did.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=()

# Tracked files a person writes: not lockfiles, minified bundles, source maps,
# or files .gitattributes marks linguist-generated. The same files the review reads.
written_files() {
  git ls-files -z \
    | git check-attr -z --stdin linguist-generated \
    | xargs -0 -n3 sh -c '[ "$2" = set ] || [ "$2" = true ] || printf "%s\n" "$0"' \
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

# Files are kept apart by type, not by the project's runtime, so a Python
# project's HTML and JavaScript are checked too.
mapfile -t files < <(written_files)
mapfile -t python < <(printf '%s\n' "${files[@]}" | grep -E '\.pyi?$')
mapfile -t go < <(printf '%s\n' "${files[@]}" | grep -E '\.go$')
# Jinja and Django templates go to djLint, since Prettier breaks their tags.
mapfile -t html < <(printf '%s\n' "${files[@]}" | grep -E '\.(html?|jinja2?|j2)$')
templates=()
for file in "${html[@]}"; do
  if [[ "$file" =~ \.(jinja2?|j2)$ ]] || grep -qE '\{%|\{\{' "$file"; then
    templates+=("$file")
  fi
done
mapfile -t prettier < <(
  printf '%s\n' "${files[@]}" \
    | grep -E '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|json5|css|scss|less|html?|vue|md|ya?ml|graphql)$' \
    | grep -vxF -f <(printf '%s\n' "${templates[@]}" | grep .)
)

if [ ${#python[@]} -gt 0 ]; then
  run "ruff format" pipx run ruff==0.17.2 format --isolated --diff -- "${python[@]}"
fi

if [ ${#go[@]} -gt 0 ]; then
  # Older gofmt exits 0 even when a file needs formatting, so any diff fails too.
  run "gofmt" bash -c 'out="$(gofmt -d -- "$@" 2>&1)"; status=$?; echo "$out"; [ "$status" -eq 0 ] && [ -z "$out" ]' gofmt "${go[@]}"
fi

if [ ${#templates[@]} -gt 0 ]; then
  # djLint reads the project's pyproject.toml even when given a config file, so it
  # checks copies in a directory with no config above them.
  copies="$(mktemp -d)"
  printf '%s\0' "${templates[@]}" | xargs -0 cp --parents -t "$copies"
  run "djLint" bash -c 'cd "$1" && shift && pipx run djlint==1.47.1 --check --profile=jinja -- "$@"' djlint "$copies" "${templates[@]}"
  rm -rf "$copies"
fi

if [ ${#prettier[@]} -gt 0 ]; then
  # No config, no .editorconfig and no ignore file: Prettier's defaults, on every file given.
  run "Prettier" "$here/node_modules/.bin/prettier" --check --no-config --no-editorconfig \
    --ignore-path /dev/null -- "${prettier[@]}"
fi

if [ ${#failed[@]} -gt 0 ]; then
  {
    echo "### Code quality"
    echo
    printf -- '- %s failed\n' "${failed[@]}"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi
