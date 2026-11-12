#!/usr/bin/env bash
# Which of a project's files the gate checks: the tracked files a person
# writes, and the helpers that pick the files of one kind from a list of them.
# Files are kept apart by type, not by the project's runtime, so a Python
# project's HTML and JavaScript are checked too. Sourced by run.sh.

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

# Each of these prints the given paths that are files of one kind.

python_files() {
  matching '\.pyi?$' "$@"
}

go_files() {
  matching '\.go$' "$@"
}

typescript_files() {
  matching '\.(ts|tsx|mts|cts)$' "$@"
}

javascript_files() {
  matching '\.(js|jsx|mjs|cjs)$' "$@"
}

docker_files() {
  matching '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.dockerfile$' "$@"
}

workflow_files() {
  matching '^\.github/workflows/[^/]+\.ya?ml$' "$@"
}

action_files() {
  matching '(^|/)action\.ya?ml$' "$@"
}

# Jinja and Django templates go to djLint, since Prettier breaks their tags.
is_template() {
  [[ "$1" =~ \.(jinja2?|j2)$ ]] || grep -qE '\{%|\{\{' "$1"
}

template_files() {
  local file
  while IFS= read -r file; do
    if is_template "$file"; then
      printf '%s\n' "$file"
    fi
  done < <(matching '\.(html?|jinja2?|j2)$' "$@")
}

plain_html_files() {
  local file
  while IFS= read -r file; do
    if ! is_template "$file"; then
      printf '%s\n' "$file"
    fi
  done < <(matching '\.html?$' "$@")
}

prettier_files() {
  matching '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|json5|css|scss|less|vue|md|ya?ml|graphql)$' "$@"
  plain_html_files "$@"
}

# Scripts named for a shell, or that start with a shebang naming one.
is_shell_script() {
  [[ "$1" == *.sh || "$1" == *.bash ]] || head -n1 "$1" | grep -qE '^#!.*[/ ](bash|dash|ksh|sh)$'
}

shell_files() {
  local file
  for file in "$@"; do
    if is_shell_script "$file"; then
      printf '%s\n' "$file"
    fi
  done
}

# Code in every language, for the size checks that treat them all alike.
source_code_files() {
  python_files "$@"
  go_files "$@"
  typescript_files "$@"
  javascript_files "$@"
  shell_files "$@"
}
