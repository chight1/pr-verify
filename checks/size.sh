#!/usr/bin/env bash
# The size and complexity checks. ESLint, ruff, golangci-lint and clang-tidy
# hold each function to the limits in their configs; these cover the rest, with
# the same numbers. Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Files over 400 lines. With GATE_SCOPE=changes, a long file fails only when the
# pull request makes it longer than it was on the base commit.
long_files() {
  local status=0 file lines base=""
  if [ "${GATE_SCOPE:-repository}" = changes ]; then
    base="$(python3 "$here/changed_code.py" base)" || return 1
  fi
  for file in "$@"; do
    lines="$(wc -l < "$file")"
    [ "$lines" -gt 400 ] || continue
    if [ -n "$base" ] && [ "$(git show "$base:$file" 2> /dev/null | wc -l)" -ge "$lines" ]; then
      continue
    fi
    echo "$file has $lines lines, over 400. Split it by what each part does." >&2
    status=1
  done
  return "$status"
}

# Runs the size checks on the given files that are code. Copies are looked for
# across every file, since changed code can copy code that did not change.
size_checks() {
  local -a python cpp source_code everything all_source_code
  mapfile -t python < <(python_files "$@")
  mapfile -t cpp < <(cpp_files "$@")
  mapfile -t source_code < <(source_code_files "$@")
  mapfile -t everything < <(written_files)
  mapfile -t all_source_code < <(source_code_files "${everything[@]}")

  if any "${python[@]}"; then
    # Cognitive complexity, which ruff does not measure.
    run "complexipy" pipx run complexipy==8.3.0 --isolated --no-ignore --snapshot-ignore \
      --max-complexity-allowed 15 --failed --plain "${python[@]}"
  fi
  if any "${cpp[@]}"; then
    # Cyclomatic complexity, which clang-tidy does not measure.
    run "lizard" pipx run lizard==1.26.0 --CCN 10 --warnings_only --languages cpp "${cpp[@]}"
  fi
  run "file length" long_files "${source_code[@]}"
  if any "${source_code[@]}"; then
    # An empty config, so a project's own jscpd settings have no effect. Full
    # paths, since jscpd otherwise prints only each file's name, and two files
    # can share one, as two tools' main.cpp do.
    run "jscpd" "$here/node_modules/.bin/jscpd" --config "$here/jscpd.json" --min-tokens 50 \
      --threshold 0 --exit-code 1 --reporters console --no-colors --absolute "${all_source_code[@]}"
  fi
}
