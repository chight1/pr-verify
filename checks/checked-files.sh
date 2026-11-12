#!/usr/bin/env bash
# Which of a project's files the gate checks: the tracked files a person
# writes, and the helpers that pick files from a list. Sourced by run.sh.

# Files a package manager writes rather than a person.
lockfiles=(
  package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb
  poetry.lock Pipfile.lock uv.lock
  go.sum Cargo.lock Gemfile.lock packages.lock.json composer.lock
)

is_lockfile() {
  local name="${1##*/}" lockfile
  for lockfile in "${lockfiles[@]}"; do
    [ "$name" = "$lockfile" ] && return 0
  done
  return 1
}

# Lockfiles, minified bundles and source maps.
is_machine_written() {
  local path="$1"
  is_lockfile "$path" || [[ "$path" == *.min.js || "$path" == *.min.css || "$path" == *.map ]]
}

# Tracked files a person writes: not machine-written ones, or files
# .gitattributes marks linguist-generated. The same files the review reads.
written_files() {
  local path value
  # check-attr prints three fields for each path, each ending in a NUL: the
  # path, the attribute's name and its value.
  git ls-files -z | git check-attr -z --stdin linguist-generated \
    | while IFS= read -r -d '' path && IFS= read -r -d '' _ && IFS= read -r -d '' value; do
      if [ "$value" = set ] || [ "$value" = true ] || is_machine_written "$path"; then
        continue
      fi
      printf '%s\n' "$path"
    done
}

# The given paths that match the extended regular expression.
matching() {
  local regex="$1"
  shift
  printf '%s\n' "$@" | grep -E "$regex"
}

# Succeeds when given any paths, for checks that run only when there are files to check.
any() {
  [ $# -gt 0 ]
}
