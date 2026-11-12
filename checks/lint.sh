#!/usr/bin/env bash
# The lint and type checks, each with the gate's config and none of the
# project's: code in each language, workflows, shell scripts and Dockerfiles,
# the Semgrep rules for common mistakes no linter here checks, and the comments
# that switch a check off. Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python_lint() {
  run "ruff check" pipx run ruff==0.17.2 check --config "$here/ruff.toml" --ignore-noqa --no-cache \
    -- "$@"
  # Checks against the Python on PATH, where the install step put the project's dependencies.
  local pyright_config="$PWD/pyrightconfig.pr-verify.json"
  remember_written "$pyright_config"
  cp "$here/pyrightconfig.json" "$pyright_config"
  run "pyright" "$here/node_modules/.bin/pyright" --project "$pyright_config" "$@"
}

# No Go linter allows a task comment that names its issue, as ruff and ESLint do here.
untracked_tasks() {
  local found
  found="$(git grep -nE '//.*\b(TODO|FIXME|XXX|HACK)\b' -- "$@" | grep -vE '#[0-9]+|https?://')"
  [ -z "$found" ] && return 0
  echo "$found"
  echo "Name the issue that tracks each of these, as TODO(#123)." >&2
  return 1
}

# Vague names, tests that are always skipped, and tests that assert nothing, in
# Python and Go. Semgrep runs from the image the static analysis step uses.
semgrep_check() {
  local semgrep_image
  semgrep_image="${SEMGREP_IMAGE:-$(sed -n 's/^  SEMGREP_IMAGE: //p' "$here/../.github/workflows/pr-verify.yml")}"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" \
    -v "$here/semgrep.yml:/rules.yml:ro" -w /src "$semgrep_image" \
    semgrep scan --config /rules.yml --error --metrics off --disable-version-check --disable-nosem \
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
    run "shellcheck" "$shellcheck_bin" --norc --severity=style -- "${shell[@]}"
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
  local -a python go templates prettier source_code shell workflows actions code markup yaml
  local found=1
  mapfile -t python < <(python_files "$@")
  mapfile -t go < <(go_files "$@")
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
  grep_files 'jscpd: *ignore' "${source_code[@]}" && found=0
  grep_files '# *shellcheck +disable' "${shell[@]}" "${workflows[@]}" "${actions[@]}" && found=0
  if [ "$found" -eq 0 ]; then
    echo "These comments switch a check off. Fix what the check found instead." >&2
    return 1
  fi
}

# Runs each linter and type checker on the given files of its kind.
lint_checks() {
  local -a python go typescript javascript dockerfiles
  mapfile -t python < <(python_files "$@")
  mapfile -t go < <(go_files "$@")
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
    run "tsc" "$here/node_modules/.bin/tsc" --project "$tsconfig"
  fi
  if any "${typescript[@]}" "${javascript[@]}"; then
    run "ESLint" env PR_VERIFY_TSCONFIG="$tsconfig" "$here/node_modules/.bin/eslint" \
      --config "$here/eslint.config.mjs" --no-inline-config --max-warnings 0 \
      -- "${typescript[@]}" "${javascript[@]}"
  fi

  if any "${go[@]}"; then
    run "golangci-lint" "$(golangci_lint)" run --config "$here/golangci.yml" ./...
    run "task comments" untracked_tasks "${go[@]}"
  fi

  if any "${python[@]}" "${go[@]}"; then
    run "Semgrep" semgrep_check "${python[@]}" "${go[@]}"
  fi

  script_checks "$@"
  if any "${dockerfiles[@]}"; then
    run "hadolint" "$(hadolint)" --config "$here/hadolint.yml" --disable-ignore-pragma \
      -- "${dockerfiles[@]}"
  fi
  run "suppressions" suppressions "$@"
}
