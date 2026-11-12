#!/usr/bin/env bash
# The formatting checks: ruff format, gofmt, djLint and Prettier, each with its
# own defaults or the gate's settings. Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Older gofmt exits 0 even when a file needs formatting, so any diff fails too.
gofmt_check() {
  local out status
  out="$(gofmt -d -- "$@" 2>&1)"
  status=$?
  echo "$out"
  [ "$status" -eq 0 ] && [ -z "$out" ]
}

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

# Runs each formatter on the given files of its kind.
formatting_checks() {
  local -a python go templates prettier
  mapfile -t python < <(python_files "$@")
  mapfile -t go < <(go_files "$@")
  mapfile -t templates < <(template_files "$@")
  mapfile -t prettier < <(prettier_files "$@")

  if any "${python[@]}"; then
    run "ruff format" pipx run ruff==0.17.2 format --isolated --diff -- "${python[@]}"
  fi
  if any "${go[@]}"; then
    run "gofmt" gofmt_check "${go[@]}"
  fi
  if any "${templates[@]}"; then
    run "djLint" djlint_check "${templates[@]}"
  fi
  if any "${prettier[@]}"; then
    # No config, no .editorconfig and no ignore file: Prettier's defaults, on every file given.
    run "Prettier" "$here/node_modules/.bin/prettier" --check --no-config --no-editorconfig \
      --ignore-path /dev/null -- "${prettier[@]}"
  fi
}
