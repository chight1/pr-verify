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

# Downloads a pinned release and checks it against its SHA-256, then prints the
# path of the binary: the download itself, or the named member of its archive.
fetch_tool() {
  local url="$1" sha256="$2" member="${3:-}"
  local dir file
  dir="$(mktemp -d)"
  file="$dir/$(basename "$url")"
  curl -fsSL -o "$file" "$url" >&2 \
    && echo "$sha256  $file" | sha256sum --check --strict --quiet >&2 \
    || return 1
  if [ -z "$member" ]; then
    chmod +x "$file" && echo "$file"
  else
    tar -xzf "$file" -C "$dir" "$member" >&2 && echo "$dir/$member"
  fi
}

golangci_lint() {
  fetch_tool https://github.com/golangci/golangci-lint/releases/download/v2.15.0/golangci-lint-2.15.0-linux-amd64.tar.gz \
    9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea \
    golangci-lint-2.15.0-linux-amd64/golangci-lint
}
actionlint() {
  fetch_tool https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
    8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 actionlint
}
shellcheck() {
  fetch_tool https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz \
    b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 shellcheck-v0.11.0/shellcheck
}
hadolint() {
  fetch_tool https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64 \
    c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
}

mapfile -t files < <(written_files)
mapfile -t workflows < <(printf '%s\n' "${files[@]}" | grep -E '^\.github/workflows/[^/]+\.ya?ml$')
mapfile -t actions < <(printf '%s\n' "${files[@]}" | grep -E '(^|/)action\.ya?ml$')

# With "online", only the checks that look things up on GitHub with the
# workflow's token, and on package registries. The gate runs them in a step of
# their own before its install step, the first to run the project's code, so no
# process the project starts is alive to read the token.
if [ "${1:-}" = online ]; then
  # zizmor's online audits look up the actions a workflow uses.
  if [ $((${#workflows[@]} + ${#actions[@]})) -gt 0 ]; then
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
  gofmt_check() {
    local out status
    out="$(gofmt -d -- "$@" 2>&1)"
    status=$?
    echo "$out"
    [ "$status" -eq 0 ] && [ -z "$out" ]
  }
  run "gofmt" gofmt_check "${go[@]}"
fi

if [ ${#templates[@]} -gt 0 ]; then
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
  pyright_config="$PWD/pyrightconfig.pr-verify.json"
  written+=("$pyright_config")
  cp "$here/pyrightconfig.json" "$pyright_config"
  run "pyright" "$here/node_modules/.bin/pyright" --project "$pyright_config" "${python[@]}"
fi

mapfile -t typescript < <(printf '%s\n' "${files[@]}" | grep -E '\.(ts|tsx|mts|cts)$')
mapfile -t javascript < <(printf '%s\n' "${files[@]}" | grep -E '\.(js|jsx|mjs|cjs)$')
tsconfig=""
if [ ${#typescript[@]} -gt 0 ]; then
  tsconfig="$PWD/tsconfig.pr-verify.json"
  written+=("$tsconfig")
  node "$here/tsconfig.mjs" "$tsconfig" "${typescript[@]}"
  run "tsc" "$here/node_modules/.bin/tsc" --project "$tsconfig"
fi
if [ $((${#typescript[@]} + ${#javascript[@]})) -gt 0 ]; then
  run "ESLint" env PR_VERIFY_TSCONFIG="$tsconfig" "$here/node_modules/.bin/eslint" \
    --config "$here/eslint.config.mjs" --no-inline-config --max-warnings 0 \
    -- "${typescript[@]}" "${javascript[@]}"
fi

if [ ${#go[@]} -gt 0 ]; then
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

# Patterns agents leave behind in Python and Go that no linter here checks:
# vague names, tests that are always skipped, and tests that assert nothing.
# Semgrep runs from the image the static analysis step uses.
if [ $((${#python[@]} + ${#go[@]})) -gt 0 ]; then
  semgrep_image="${SEMGREP_IMAGE:-$(sed -n 's/^  SEMGREP_IMAGE: //p' "$here/../.github/workflows/pr-verify.yml")}"
  run "agent patterns" docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" \
    -v "$here/agent-patterns.yml:/rules.yml:ro" -w /src "$semgrep_image" \
    semgrep scan --config /rules.yml --error --metrics off --disable-version-check --disable-nosem \
    -- "${python[@]}" "${go[@]}"
fi

# Size and complexity. ESLint, ruff and golangci-lint hold each function to the
# limits in their configs; these cover the rest, with the same numbers.

mapfile -t source_code < <(
  printf '%s\n' "${files[@]}" | grep -E '\.(pyi?|go|js|jsx|mjs|cjs|ts|tsx|mts|cts|sh|bash)$'
)

if [ ${#python[@]} -gt 0 ]; then
  # Cognitive complexity, which ruff does not measure.
  run "complexipy" pipx run complexipy==8.3.0 --isolated --no-ignore --snapshot-ignore     --max-complexity-allowed 15 --plain "${python[@]}"
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

if [ ${#source_code[@]} -gt 0 ]; then
  run "jscpd" "$here/node_modules/.bin/jscpd" --config "$here/jscpd.json" --min-tokens 50     --threshold 0 --exit-code 1 --reporters console --no-colors "${source_code[@]}"
fi

# Dead code and dependencies.

# Only where deptry can read the dependencies: a pyproject.toml that declares
# them, or a requirements.txt.
if [ ${#python[@]} -gt 0 ] && { grep -qsE '^\[(project|tool\.poetry|tool\.pdm)\]' pyproject.toml \
  || [ -f requirements.txt ]; }; then
  # Imports that no dependency provides, dependencies nothing imports, and imports
  # of packages that only arrive through another dependency. deptry maps packages
  # to modules from installed metadata, so it reads the project's environment.
  # Flags override every setting that would hide a finding.
  site_packages="$(python -c 'import site; print(":".join(site.getsitepackages()))')"
  run "deptry" env PYTHONPATH="$site_packages" pipx run deptry==0.25.1 . \
    --ignore DEP000 --per-rule-ignores DEP000=none --extend-exclude '^$' \
    --exclude 'venv|\.venv|\.direnv|tests|\.git|setup\.py'
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

if [ -f package.json ] && [ $((${#typescript[@]} + ${#javascript[@]})) -gt 0 ]; then
  # Unused files, exports and types, imports of packages the manifest does not
  # list, duplicate exports and import cycles.
  knip_check() {
    local config="$PWD/knip.pr-verify.json" generated
    written+=("$config")
    mapfile -t generated < <(comm -23 <(git ls-files | sort) <(printf '%s\n' "${files[@]}" | sort))
    node "$here/knip-config.mjs" "$config" "${generated[@]}"
    "$here/node_modules/.bin/knip" --config "$config" --no-progress --no-config-hints \
      --include files,unlisted,unresolved,exports,types,nsExports,nsTypes,enumMembers,duplicates,cycles
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
  if [ ${#prose[@]} -gt 0 ] && git grep -nIE '[[:blank:]]+$' -- "${prose[@]}"; then
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

mapfile -t shell < <(
  for file in "${files[@]}"; do
    if [[ "$file" =~ \.(sh|bash)$ ]] || head -n1 "$file" | grep -qE '^#!.*[/ ](bash|dash|ksh|sh)$'; then
      echo "$file"
    fi
  done
)
shellcheck_bin=""
if [ $((${#workflows[@]} + ${#shell[@]})) -gt 0 ]; then
  shellcheck_bin="$(shellcheck)"
fi
if [ ${#workflows[@]} -gt 0 ]; then
  # actionlint runs shellcheck on every run: block, with the same pinned copy.
  # 1.7.12 predates GitHub's $/ syntax for same-repository references and
  # rejects it, so those two messages, and only for $/ references, are ignored.
  run "actionlint" "$(actionlint)" -config-file "$here/actionlint.yml" -shellcheck "$shellcheck_bin" \
    -ignore '"\$/[^"]*" at "uses" is not following the format' \
    -ignore 'action "\$/[^"]*" in invalid format because ref is missing' \
    -- "${workflows[@]}"
fi
if [ ${#shell[@]} -gt 0 ]; then
  run "shellcheck" "$shellcheck_bin" --norc --severity=style -- "${shell[@]}"
fi

mapfile -t dockerfiles < <(
  printf '%s\n' "${files[@]}" | grep -E '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.dockerfile$'
)
if [ ${#dockerfiles[@]} -gt 0 ]; then
  run "hadolint" "$(hadolint)" --config "$here/hadolint.yml" --disable-ignore-pragma \
    -- "${dockerfiles[@]}"
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
  grep_files 'jscpd[:]ignore' "${source_code[@]}" && found=0
  grep_files '#[ ]*shellcheck[ ]+disable' "${shell[@]}" "${workflows[@]}" "${actions[@]}" && found=0
  if [ "$found" -eq 0 ]; then
    echo "These comments switch a check off. Fix what the check found instead." >&2
    return 1
  fi
}
run "suppressions" suppressions

summarize "Code quality"
