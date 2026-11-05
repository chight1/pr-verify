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

# golangci-lint from a pinned release, checked against its SHA-256. Prints its path.
install_golangci_lint() {
  local version=2.15.0
  local sha256=9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea
  local name="golangci-lint-$version-linux-amd64"
  local dir
  dir="$(mktemp -d)"
  curl -fsSL -o "$dir/$name.tar.gz" \
    "https://github.com/golangci/golangci-lint/releases/download/v$version/$name.tar.gz" >&2 \
    && echo "$sha256  $dir/$name.tar.gz" | sha256sum --check --strict --quiet >&2 \
    && tar -xzf "$dir/$name.tar.gz" -C "$dir" --strip-components 1 "$name/golangci-lint" >&2 \
    && echo "$dir/golangci-lint"
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

# Lint and types, each with the gate's config and none of the project's.

if [ ${#python[@]} -gt 0 ]; then
  run "ruff check" pipx run ruff==0.17.2 check --config "$here/ruff.toml" --ignore-noqa --no-cache \
    -- "${python[@]}"
  # Checks against the Python on PATH, where the install step put the project's dependencies.
  run "pyright" "$here/node_modules/.bin/pyright" --project "$here/pyrightconfig.json" "${python[@]}"
fi

mapfile -t typescript < <(printf '%s\n' "${files[@]}" | grep -E '\.(ts|tsx|mts|cts)$')
mapfile -t javascript < <(printf '%s\n' "${files[@]}" | grep -E '\.(js|jsx|mjs|cjs)$')
tsconfig=""
if [ ${#typescript[@]} -gt 0 ]; then
  # At the project root, since TypeScript resolves rootDir and type packages from
  # the config's own directory. It is untracked and removed when the script exits.
  tsconfig="$PWD/tsconfig.pr-verify.json"
  trap 'rm -f "$tsconfig"' EXIT
  node "$here/tsconfig.mjs" "$tsconfig" "${typescript[@]}"
  run "tsc" "$here/node_modules/.bin/tsc" --project "$tsconfig"
fi
if [ $((${#typescript[@]} + ${#javascript[@]})) -gt 0 ]; then
  run "ESLint" env PR_VERIFY_TSCONFIG="$tsconfig" "$here/node_modules/.bin/eslint" \
    --config "$here/eslint.config.mjs" --no-inline-config --max-warnings 0 \
    -- "${typescript[@]}" "${javascript[@]}"
fi

if [ ${#go[@]} -gt 0 ]; then
  run "golangci-lint" bash -c '"$1" run --config "$2" ./...' golangci-lint "$(install_golangci_lint)" \
    "$here/golangci.yml"
fi

# Comments that switch a check off, for tools with no flag to ignore them, in
# each tool's own comment syntax and only in the files it reads, so prose that
# names a directive does not match. The brackets keep this file from matching.
grep_files() {
  local pattern="$1"
  shift
  [ $# -gt 0 ] && git grep -nE "$pattern" -- "$@"
}
suppressions() {
  local markup yaml code found=1
  mapfile -t markup < <(printf '%s\n' "${prettier[@]}" | grep -E '\.(html?|vue|md)$')
  mapfile -t yaml < <(printf '%s\n' "${prettier[@]}" | grep -E '\.ya?ml$')
  mapfile -t code < <(printf '%s\n' "${prettier[@]}" | grep -vE '\.(html?|vue|md|ya?ml)$')
  grep_files '#[ ]*(pyright[:]|fmt[:][ ]*(off|skip)|isort[:][ ]*(off|skip))' "${python[@]}" && found=0
  grep_files '(//|/[*])[ ]*prettier[-]ignore' "${code[@]}" && found=0
  grep_files '<!--[ ]*prettier[-]ignore' "${markup[@]}" && found=0
  grep_files '#[ ]*prettier[-]ignore' "${yaml[@]}" && found=0
  grep_files '(\{#|<!--)[ ]*djlint[:]off' "${templates[@]}" && found=0
  grep_files '//[ ]*(nolint|lint[:]ignore)' "${go[@]}" && found=0
  if [ "$found" -eq 0 ]; then
    echo "These comments switch a check off. Fix what the check found instead." >&2
    return 1
  fi
}
run "suppressions" suppressions

if [ ${#failed[@]} -gt 0 ]; then
  {
    echo "### Code quality"
    echo
    printf -- '- %s failed\n' "${failed[@]}"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 1
fi
