#!/usr/bin/env bash
# The checks on the files themselves, in every project: line endings and
# whitespace, file size, and spelling. Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# CRLF line endings, trailing whitespace and a missing final newline, in every
# text file, including the ones no formatter reads. Markdown is left to Prettier,
# since two trailing spaces there are a line break.
whitespace() {
  local text prose status=0 file
  mapfile -t text < <(git grep -lI '' -- "$@")
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

# Files over 1 MB belong in Git LFS.
large_files() {
  local status=0 file
  for file in "$@"; do
    [ "$(stat -c %s "$file")" -gt 1048576 ] || continue
    git check-attr filter -- "$file" | grep -q ': lfs$' && continue
    echo "$file is over 1 MB. Store it with Git LFS." >&2
    status=1
  done
  return "$status"
}

# Misspelled words in code, comments, docs and file names. A project's typos
# config can teach typos a word, such as a name in its license, and nothing else.
typos_check() {
  local config status
  config="$(mktemp --suffix .toml)"
  python3 "$here/typos_config.py" "$config" \
    && pipx run typos==1.51.1 --isolated --config "$config" --format brief -- "$@"
  status=$?
  rm -f "$config"
  return "$status"
}

# Runs the file hygiene checks on every given file.
file_hygiene_checks() {
  run "whitespace" whitespace "$@"
  run "file size" large_files "$@"
  run "typos" typos_check "$@"
}
