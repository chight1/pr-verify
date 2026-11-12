#!/usr/bin/env bash
# The size and complexity checks. ESLint, ruff and golangci-lint hold each
# function to the limits in their configs; these cover the rest, with the same
# numbers. Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Runs the size checks on the given files that are code.
size_checks() {
  local -a python source_code
  mapfile -t python < <(python_files "$@")
  mapfile -t source_code < <(source_code_files "$@")

  if any "${python[@]}"; then
    # Cognitive complexity, which ruff does not measure.
    run "complexipy" pipx run complexipy==8.3.0 --isolated --no-ignore --snapshot-ignore \
      --max-complexity-allowed 15 --plain "${python[@]}"
  fi
  run "file length" long_files "${source_code[@]}"
  if any "${source_code[@]}"; then
    # An empty config, so a project's own jscpd settings have no effect.
    run "jscpd" "$here/node_modules/.bin/jscpd" --config "$here/jscpd.json" --min-tokens 50 \
      --threshold 0 --exit-code 1 --reporters console --no-colors "${source_code[@]}"
  fi
}
