#!/usr/bin/env bash
# The lint and type checks, each with the gate's config and none of the
# project's: code in each language, workflows, shell scripts and Dockerfiles,
# the Semgrep rules for common mistakes no linter here checks, and the comments
# that switch a check off. Each prints every finding on a line of its own that
# names the file and line, so that with GATE_SCOPE=changes run.sh can tell which
# findings are in changed code. Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python_lint() {
  run "ruff check" pipx run ruff==0.17.2 check --config "$here/ruff.toml" --ignore-noqa --no-cache \
    --output-format concise -- "$@"
  # Checks against the Python on PATH, where the install step put the project's dependencies.
  local pyright_config="$PWD/pyrightconfig.pr-verify.json"
  remember_written "$pyright_config"
  cp "$here/pyrightconfig.json" "$pyright_config"
  run "pyright" "$here/node_modules/.bin/pyright" --project "$pyright_config" "$@"
}

# clang-tidy on each C++ source file, and on the project's own headers it
# includes, with the flags CMake recorded for it, many files at a time. Headers
# CMake generated, in the directory it wrote the commands to, are left out. The
# paths go into the header filters as they are: a checkout's path has no
# character a regular expression treats specially but the dot, which matches
# itself as well.
#
# The compiler's warnings go on top of the project's flags, after them, so a
# project's -Wno- flag cannot turn one off. clang-tidy guesses the flags of a
# file CMake does not list from a file near it, and puts the file's name last
# behind a --, so anything added after it would be read as a file name; those
# files get the warnings before their flags instead. A GCC project's flags that
# clang does not know are not findings.
clang_tidy_check() {
  local commands clang_tidy_bin warning status=0
  commands="$(compile_commands_dir)" || return 1
  clang_tidy_bin="$(clang_tidy)" || return 1
  local -a options=(-p "$commands" --config-file="$here/clang-tidy.yml" --quiet --header-filter="^$PWD/")
  if [ "$commands" != "$PWD" ]; then
    options+=(--exclude-header-filter="^$commands/")
  fi
  local -a after=() before=() listed guessed
  for warning in -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wold-style-cast \
    -Wmissing-declarations -Wno-unknown-warning-option -Wno-unused-command-line-argument; do
    after+=("--extra-arg=$warning")
    before+=("--extra-arg-before=$warning")
  done
  mapfile -t listed < <(python3 "$here/compiled_files.py" "$commands/compile_commands.json" "$@")
  mapfile -t guessed < <(comm -23 <(printf '%s\n' "$@" | sort) <(printf '%s\n' "${listed[@]}" | sort))
  if any "${listed[@]}"; then
    printf '%s\0' "${listed[@]}" | xargs -0 -n 4 -P "$(nproc)" "$clang_tidy_bin" "${options[@]}" \
      "${after[@]}" || status=1
  fi
  if any "${guessed[@]}"; then
    printf '%s\0' "${guessed[@]}" | xargs -0 -n 4 -P "$(nproc)" "$clang_tidy_bin" "${options[@]}" \
      "${before[@]}" || status=1
  fi
  return "$status"
}

# Comment lines that end the way a statement or a block does, the mark of code
# commented out, which no C++ linter here checks for.
commented_out_code() {
  local found
  found="$(git grep -nE '^\s*//.*[;{}]\s*$' -- "$@")"
  [ -z "$found" ] && return 0
  echo "$found"
  echo "Delete commented-out code instead of keeping it. Git keeps the history." >&2
  return 1
}

# No Go or C++ linter allows a task comment that names its issue, as ruff and ESLint do here.
untracked_tasks() {
  local found
  found="$(git grep -nE '//.*\b(TODO|FIXME|XXX|HACK)\b' -- "$@" | grep -vE '#[0-9]+|https?://')"
  [ -z "$found" ] && return 0
  echo "$found"
  echo "Name the issue that tracks each of these, as TODO(#123)." >&2
  return 1
}

# Vague names, tests that are always skipped, and tests that assert nothing, in
# Python, Go and C++, and C++'s debug output. Semgrep runs from the image the
# static analysis step uses.
semgrep_check() {
  local semgrep_image
  semgrep_image="${SEMGREP_IMAGE:-$(sed -n 's/^  SEMGREP_IMAGE: //p' "$here/../.github/workflows/pr-verify.yml")}"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" \
    -v "$here/semgrep.yml:/rules.yml:ro" -w /src "$semgrep_image" \
    semgrep scan --config /rules.yml --error --metrics off --disable-version-check --disable-nosem --emacs \
    -- "$@"
}

# Workflows with actionlint, which runs shellcheck on every run: block, and
# shell scripts with the same pinned shellcheck.
script_checks() {
  local -a workflows shell
  mapfile -t workflows < <(workflow_files "$@")
  mapfile -t shell < <(shell_files "$@")
  any "${workflows[@]}" "${shell[@]}" || return 0
  local shellcheck_bin
  shellcheck_bin="$(shellcheck)"
  if any "${workflows[@]}"; then
    # actionlint 1.7.12 predates GitHub's $/ syntax for same-repository references
    # and rejects it, so those two messages, and only for $/ references, are ignored.
    run "actionlint" "$(actionlint)" -config-file "$here/actionlint.yml" -shellcheck "$shellcheck_bin" \
      -ignore '"\$/[^"]*" at "uses" is not following the format' \
      -ignore 'action "\$/[^"]*" in invalid format because ref is missing' \
      -- "${workflows[@]}"
  fi
  if any "${shell[@]}"; then
    run "shellcheck" "$shellcheck_bin" --norc --severity=style --format gcc -- "${shell[@]}"
  fi
}

# Comments that switch a check off, for tools with no flag to ignore them, in
# each tool's own comment syntax and only in the files it reads, so prose that
# names a directive does not match.
grep_files() {
  local pattern="$1"
  shift
  any "$@" && git grep -nE "$pattern" -- "$@"
}

suppressions() {
  local -a python go cpp templates prettier source_code shell workflows actions code markup yaml
  local found=1
  mapfile -t python < <(python_files "$@")
  mapfile -t go < <(go_files "$@")
  mapfile -t cpp < <(cpp_files "$@")
  mapfile -t templates < <(template_files "$@")
  mapfile -t prettier < <(prettier_files "$@")
  mapfile -t source_code < <(source_code_files "$@")
  mapfile -t shell < <(shell_files "$@")
  mapfile -t workflows < <(workflow_files "$@")
  mapfile -t actions < <(action_files "$@")
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
  # clang-tidy's NOLINT, clang-format's off switch, lizard's forgiveness, and
  # the pragmas that turn a compiler warning off.
  grep_files '(//|/\*) *(NOLINT|clang-format +off|#lizard +forgives)' "${cpp[@]}" && found=0
  grep_files '#pragma +((GCC|clang) +diagnostic +ignored|warning *\( *disable)' "${cpp[@]}" && found=0
  grep_files 'jscpd: *ignore' "${source_code[@]}" && found=0
  grep_files '# *shellcheck +disable' "${shell[@]}" "${workflows[@]}" "${actions[@]}" && found=0
  if [ "$found" -eq 0 ]; then
    echo "These comments switch a check off. Fix what the check found instead." >&2
    return 1
  fi
}

# Runs each linter and type checker on the given files of its kind.
lint_checks() {
  local -a python go cpp cpp_sources typescript javascript dockerfiles
  mapfile -t python < <(python_files "$@")
  mapfile -t go < <(go_files "$@")
  mapfile -t cpp < <(cpp_files "$@")
  mapfile -t cpp_sources < <(cpp_source_files "$@")
  mapfile -t typescript < <(typescript_files "$@")
  mapfile -t javascript < <(javascript_files "$@")
  mapfile -t dockerfiles < <(docker_files "$@")

  if any "${python[@]}"; then
    python_lint "${python[@]}"
  fi

  local tsconfig=""
  if any "${typescript[@]}"; then
    tsconfig="$PWD/tsconfig.pr-verify.json"
    remember_written "$tsconfig"
    node "$here/tsconfig.mjs" "$tsconfig" "${typescript[@]}"
    run "tsc" "$here/node_modules/.bin/tsc" --project "$tsconfig" --pretty false
  fi
  if any "${typescript[@]}" "${javascript[@]}"; then
    run "ESLint" env PR_VERIFY_TSCONFIG="$tsconfig" "$here/node_modules/.bin/eslint" \
      --config "$here/eslint.config.mjs" --no-inline-config --max-warnings 0 \
      --format "$here/eslint-locations.mjs" \
      -- "${typescript[@]}" "${javascript[@]}"
  fi

  if any "${go[@]}"; then
    run "golangci-lint" "$(golangci_lint)" run --config "$here/golangci.yml" ./...
  fi
  if any "${cpp_sources[@]}"; then
    run "clang-tidy" clang_tidy_check "${cpp_sources[@]}"
  fi
  if any "${cpp[@]}"; then
    run "commented-out code" commented_out_code "${cpp[@]}"
  fi
  if any "${go[@]}" "${cpp[@]}"; then
    run "task comments" untracked_tasks "${go[@]}" "${cpp[@]}"
  fi

  if any "${python[@]}" "${go[@]}" "${cpp[@]}"; then
    run "Semgrep" semgrep_check "${python[@]}" "${go[@]}" "${cpp[@]}"
  fi

  script_checks "$@"
  if any "${dockerfiles[@]}"; then
    run "hadolint" "$(hadolint)" --config "$here/hadolint.yml" --disable-ignore-pragma \
      -- "${dockerfiles[@]}"
  fi
  run "suppressions" suppressions "$@"
}
