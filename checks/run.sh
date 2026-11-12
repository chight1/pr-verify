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

# Which files are checked, and the pinned tools that check them.
# shellcheck source=checks/checked-files.sh
source "$here/checked-files.sh"
# shellcheck source=checks/tool-downloads.sh
source "$here/tool-downloads.sh"

# The project's files that match the extended regular expression.
files_matching() {
  matching "$1" "${files[@]}"
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
mapfile -t workflows < <(files_matching '^\.github/workflows/[^/]+\.ya?ml$')
mapfile -t actions < <(files_matching '(^|/)action\.ya?ml$')

# With "online", only the checks that look things up on GitHub with the
# workflow's token, and on package registries. The gate runs them in a step of
# their own before its install step, the first to run the project's code, so no
# process the project starts is alive to read the token.
if [ "${1:-}" = online ]; then
  # zizmor's online audits look up the actions a workflow uses.
  if any "${workflows[@]}" "${actions[@]}"; then
    run "zizmor" pipx run zizmor==1.31.1 --config "$here/zizmor.yml" --no-ignores --no-progress \
      "${workflows[@]}" "${actions[@]}"
  fi
  # A dependency the pull request adds that its registry has had for under 30
  # days, or does not have: a name a model made up, or one registered to catch
  # it. The token fetches the pull request's base commit to compare with.
  run "new dependencies" python3 "$here/new_dependencies.py" "${files[@]}"
  summarize "Online checks"
  exit
fi

# Files are kept apart by type, not by the project's runtime, so a Python
# project's HTML and JavaScript are checked too.
mapfile -t python < <(files_matching '\.pyi?$')
mapfile -t go < <(files_matching '\.go$')
mapfile -t typescript < <(files_matching '\.(ts|tsx|mts|cts)$')
mapfile -t javascript < <(files_matching '\.(js|jsx|mjs|cjs)$')
mapfile -t dockerfiles < <(files_matching '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.dockerfile$')

# Jinja and Django templates go to djLint, since Prettier breaks their tags.
mapfile -t html < <(files_matching '\.(html?|jinja2?|j2)$')
templates=()
plain_html=()
for file in "${html[@]}"; do
  if [[ "$file" =~ \.(jinja2?|j2)$ ]] || grep -qE '\{%|\{\{' "$file"; then
    templates+=("$file")
  else
    plain_html+=("$file")
  fi
done
mapfile -t prettier < <(
  files_matching '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|json5|css|scss|less|vue|md|ya?ml|graphql)$'
)
prettier+=("${plain_html[@]}")

# Scripts named for a shell, or that start with a shebang naming one.
is_shell_script() {
  [[ "$1" == *.sh || "$1" == *.bash ]] || head -n1 "$1" | grep -qE '^#!.*[/ ](bash|dash|ksh|sh)$'
}
shell=()
for file in "${files[@]}"; do
  if is_shell_script "$file"; then
    shell+=("$file")
  fi
done

# Code in every language, for the size checks that treat them all alike.
source_code=("${python[@]}" "${go[@]}" "${typescript[@]}" "${javascript[@]}" "${shell[@]}")

# Formatting.

if any "${python[@]}"; then
  run "ruff format" pipx run ruff==0.17.2 format --isolated --diff -- "${python[@]}"
fi

if any "${go[@]}"; then
  # Older gofmt exits 0 even when a file needs formatting, so any diff fails too.
  gofmt_check() {
    local out status
    out="$(gofmt -d -- "$@" 2>&1)"
    status=$?
    echo "$out"
    [ "$status" -eq 0 ] && [ -z "$out" ]
  }
  run "gofmt" gofmt_check "${go[@]}"
fi

if any "${templates[@]}"; then
  # djLint reads the project's pyproject.toml even when given a config file, so it
  # checks copies in a directory with no config above them.
  djlint_check() {
    local copies status
    copies="$(mktemp -d)"
    cp --parents -t "$copies" -- "$@"
    (cd "$copies" && pipx run djlint==1.47.1 --check --profile=jinja -- "$@")
    status=$?
    rm -rf "$copies"
    return "$status"
  }
  run "djLint" djlint_check "${templates[@]}"
fi

if any "${prettier[@]}"; then
  # No config, no .editorconfig and no ignore file: Prettier's defaults, on every file given.
  run "Prettier" "$here/node_modules/.bin/prettier" --check --no-config --no-editorconfig \
    --ignore-path /dev/null -- "${prettier[@]}"
fi

# Lint and types, each with the gate's config and none of the project's.

if any "${python[@]}"; then
  run "ruff check" pipx run ruff==0.17.2 check --config "$here/ruff.toml" --ignore-noqa --no-cache \
    -- "${python[@]}"
  # Checks against the Python on PATH, where the install step put the project's dependencies.
  pyright_config="$PWD/pyrightconfig.pr-verify.json"
  written+=("$pyright_config")
  cp "$here/pyrightconfig.json" "$pyright_config"
  run "pyright" "$here/node_modules/.bin/pyright" --project "$pyright_config" "${python[@]}"
fi

tsconfig=""
if any "${typescript[@]}"; then
  tsconfig="$PWD/tsconfig.pr-verify.json"
  written+=("$tsconfig")
  node "$here/tsconfig.mjs" "$tsconfig" "${typescript[@]}"
  run "tsc" "$here/node_modules/.bin/tsc" --project "$tsconfig"
fi
if any "${typescript[@]}" "${javascript[@]}"; then
  run "ESLint" env PR_VERIFY_TSCONFIG="$tsconfig" "$here/node_modules/.bin/eslint" \
    --config "$here/eslint.config.mjs" --no-inline-config --max-warnings 0 \
    -- "${typescript[@]}" "${javascript[@]}"
fi

if any "${go[@]}"; then
  run "golangci-lint" "$(golangci_lint)" run --config "$here/golangci.yml" ./...
  # No Go linter allows a task comment that names its issue, as ruff and ESLint do here.
  untracked_tasks() {
    local found
    found="$(git grep -nE '//.*\b(TODO|FIXME|XXX|HACK)\b' -- "$@" | grep -vE '#[0-9]+|https?://')"
    [ -z "$found" ] && return 0
    echo "$found"
    echo "Name the issue that tracks each of these, as TODO(#123)." >&2
    return 1
  }
  run "task comments" untracked_tasks "${go[@]}"
fi

# Common mistakes in Python and Go that no linter here checks:
# vague names, tests that are always skipped, and tests that assert nothing.
# Semgrep runs from the image the static analysis step uses.
if any "${python[@]}" "${go[@]}"; then
  semgrep_image="${SEMGREP_IMAGE:-$(sed -n 's/^  SEMGREP_IMAGE: //p' "$here/../.github/workflows/pr-verify.yml")}"
  run "Semgrep" docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" \
    -v "$here/semgrep.yml:/rules.yml:ro" -w /src "$semgrep_image" \
    semgrep scan --config /rules.yml --error --metrics off --disable-version-check --disable-nosem \
    -- "${python[@]}" "${go[@]}"
fi

# Size and complexity. ESLint, ruff and golangci-lint hold each function to the
# limits in their configs; these cover the rest, with the same numbers.

if any "${python[@]}"; then
  # Cognitive complexity, which ruff does not measure.
  run "complexipy" pipx run complexipy==8.3.0 --isolated --no-ignore --snapshot-ignore \
    --max-complexity-allowed 15 --plain "${python[@]}"
fi

long_files() {
  local status=0 file lines
  for file in "$@"; do
    lines="$(wc -l < "$file")"
    if [ "$lines" -gt 400 ]; then
      echo "$file has $lines lines, over 400. Split it by what each part does." >&2
      status=1
    fi
  done
  return "$status"
}
run "file length" long_files "${source_code[@]}"

if any "${source_code[@]}"; then
  run "jscpd" "$here/node_modules/.bin/jscpd" --config "$here/jscpd.json" --min-tokens 50 \
    --threshold 0 --exit-code 1 --reporters console --no-colors "${source_code[@]}"
fi

# Dead code and dependencies.

# Where deptry can read the dependencies: a pyproject.toml that declares them,
# or a requirements.txt.
declares_python_dependencies() {
  grep -qsE '^\[(project|tool\.poetry|tool\.pdm)\]' pyproject.toml || [ -f requirements.txt ]
}
if any "${python[@]}" && declares_python_dependencies; then
  # Imports that no dependency provides, dependencies nothing imports, and imports
  # of packages that only arrive through another dependency. deptry maps packages
  # to modules from installed metadata, so it reads the project's environment.
  site_packages="$(python -c 'import site; print(":".join(site.getsitepackages()))')"
  # Each flag replaces a project setting that could hide a finding.
  deptry_overrides=(
    # Ignored rules: only DEP000, which does not exist.
    --ignore DEP000
    # Packages ignored for each rule: none.
    --per-rule-ignores DEP000=none
    # Paths excluded on top of the defaults: a pattern no path matches.
    --extend-exclude '^$'
    # Paths excluded: deptry's defaults.
    --exclude 'venv|\.venv|\.direnv|tests|\.git|setup\.py'
  )
  run "deptry" env PYTHONPATH="$site_packages" pipx run deptry==0.25.1 . "${deptry_overrides[@]}"
fi

if [ -f go.mod ]; then
  run "go mod tidy" go mod tidy -diff
  # Functions nothing reaches, from main packages and tests. deadcode reports
  # without failing, so anything it prints fails. Go's own notices, such as a
  # toolchain switch, go to stderr and do not count.
  deadcode_check() {
    local out
    out="$(go run golang.org/x/tools/cmd/deadcode@v0.52.0 -test ./...)" || return 1
    echo "$out"
    [ -z "$out" ]
  }
  run "deadcode" deadcode_check
fi

# Tracked files that every check leaves out. comm -23 prints the lines only the
# first list has.
left_out_files() {
  comm -23 <(git ls-files | sort) <(printf '%s\n' "${files[@]}" | sort)
}

if [ -f package.json ] && any "${typescript[@]}" "${javascript[@]}"; then
  # Unused files, exports and types, imports of packages the manifest does not
  # list, duplicate exports and import cycles. An entry point written as a
  # pattern fails the check, and knip still runs without it.
  knip_check() {
    local config="$PWD/knip.pr-verify.json" ignored status=0
    written+=("$config")
    mapfile -t ignored < <(left_out_files)
    node "$here/knip-config.mjs" "$config" "${ignored[@]}" || status=1
    "$here/node_modules/.bin/knip" --config "$config" --no-progress --no-config-hints \
      --include files,unlisted,unresolved,exports,types,nsExports,nsTypes,enumMembers,duplicates,cycles \
      || status=1
    return "$status"
  }
  run "knip" knip_check
fi

# Every project, whatever its runtime.

# CRLF line endings, trailing whitespace and a missing final newline, in every
# text file, including the ones no formatter reads. Markdown is left to Prettier,
# since two trailing spaces there are a line break.
whitespace() {
  local text prose status=0 file
  mapfile -t text < <(git grep -lI '' -- "${files[@]}")
  mapfile -t prose < <(printf '%s\n' "${text[@]}" | grep -vE '\.md$')
  if git grep -nI $'\r$' -- "${text[@]}"; then
    echo "Use LF line endings." >&2
    status=1
  fi
  if any "${prose[@]}" && git grep -nIE '[[:blank:]]+$' -- "${prose[@]}"; then
    echo "Remove trailing whitespace." >&2
    status=1
  fi
  for file in "${text[@]}"; do
    if [ -n "$(tail -c1 "$file")" ]; then
      echo "$file: no newline at the end of the file" >&2
      status=1
    fi
  done
  return "$status"
}
run "whitespace" whitespace

# Files over 1 MB belong in Git LFS.
large_files() {
  local status=0 file
  for file in "${files[@]}"; do
    [ "$(stat -c %s "$file")" -gt 1048576 ] || continue
    git check-attr filter -- "$file" | grep -q ': lfs$' && continue
    echo "$file is over 1 MB. Store it with Git LFS." >&2
    status=1
  done
  return "$status"
}
run "file size" large_files

# Misspelled words in code, comments, docs and file names. A project's typos
# config can teach typos a word, such as a name in its license, and nothing else.
typos_check() {
  local config status
  config="$(mktemp --suffix .toml)"
  python3 "$here/typos_config.py" "$config" \
    && pipx run typos==1.51.1 --isolated --config "$config" --format brief -- "${files[@]}"
  status=$?
  rm -f "$config"
  return "$status"
}
run "typos" typos_check

shellcheck_bin=""
if any "${workflows[@]}" "${shell[@]}"; then
  shellcheck_bin="$(shellcheck)"
fi
if any "${workflows[@]}"; then
  # actionlint runs shellcheck on every run: block, with the same pinned copy.
  # 1.7.12 predates GitHub's $/ syntax for same-repository references and
  # rejects it, so those two messages, and only for $/ references, are ignored.
  run "actionlint" "$(actionlint)" -config-file "$here/actionlint.yml" -shellcheck "$shellcheck_bin" \
    -ignore '"\$/[^"]*" at "uses" is not following the format' \
    -ignore 'action "\$/[^"]*" in invalid format because ref is missing' \
    -- "${workflows[@]}"
fi
if any "${shell[@]}"; then
  run "shellcheck" "$shellcheck_bin" --norc --severity=style -- "${shell[@]}"
fi

if any "${dockerfiles[@]}"; then
  run "hadolint" "$(hadolint)" --config "$here/hadolint.yml" --disable-ignore-pragma \
    -- "${dockerfiles[@]}"
fi

# Comments that switch a check off, for tools with no flag to ignore them, in
# each tool's own comment syntax and only in the files it reads, so prose that
# names a directive does not match.
grep_files() {
  local pattern="$1"
  shift
  any "$@" && git grep -nE "$pattern" -- "$@"
}
suppressions() {
  local code markup yaml found=1
  mapfile -t code < <(
    matching '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|json5|css|scss|less|graphql)$' "${prettier[@]}"
  )
  mapfile -t markup < <(matching '\.(html?|vue|md)$' "${prettier[@]}")
  mapfile -t yaml < <(matching '\.ya?ml$' "${prettier[@]}")
  grep_files '# *(pyright:|fmt: *(off|skip)|isort: *(off|skip))' "${python[@]}" && found=0
  grep_files '(//|/\*) *prettier-ignore' "${code[@]}" && found=0
  grep_files '<!-- *prettier-ignore' "${markup[@]}" && found=0
  grep_files '# *prettier-ignore' "${yaml[@]}" && found=0
  grep_files '(\{#|<!--) *djlint:off' "${templates[@]}" && found=0
  grep_files '// *(nolint|lint:ignore)' "${go[@]}" && found=0
  grep_files 'jscpd: *ignore' "${source_code[@]}" && found=0
  grep_files '# *shellcheck +disable' "${shell[@]}" "${workflows[@]}" "${actions[@]}" && found=0
  if [ "$found" -eq 0 ]; then
    echo "These comments switch a check off. Fix what the check found instead." >&2
    return 1
  fi
}
run "suppressions" suppressions

summarize "Code quality"
