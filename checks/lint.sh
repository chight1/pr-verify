#!/usr/bin/env bash
# The lint and type checks, each with the gate's config and none of the
# project's, and the Semgrep rules for common mistakes no linter here checks.
# Sourced by run.sh.

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

# Runs each linter and type checker on the given files of its kind.
lint_checks() {
  local -a python go typescript javascript
  mapfile -t python < <(python_files "$@")
  mapfile -t go < <(go_files "$@")
  mapfile -t typescript < <(typescript_files "$@")
  mapfile -t javascript < <(javascript_files "$@")

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
}
