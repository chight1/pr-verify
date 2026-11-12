#!/usr/bin/env bash
# The checks every project gets, whatever its runtime: whitespace, file size,
# spelling, workflows, shell scripts, Dockerfiles, and the comments that switch
# a check off. Sourced by run.sh.

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

# Runs every check that applies to any project on the given files.
every_file_checks() {
  local -a dockerfiles
  mapfile -t dockerfiles < <(docker_files "$@")

  run "whitespace" whitespace "$@"
  run "file size" large_files "$@"
  run "typos" typos_check "$@"
  script_checks "$@"
  if any "${dockerfiles[@]}"; then
    run "hadolint" "$(hadolint)" --config "$here/hadolint.yml" --disable-ignore-pragma \
      -- "${dockerfiles[@]}"
  fi
  run "suppressions" suppressions "$@"
}
