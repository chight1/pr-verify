#!/usr/bin/env bash
# The dead code and dependency checks: deptry, go mod tidy, deadcode and knip.
# Sourced by run.sh.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where deptry can read the dependencies: a pyproject.toml that declares them,
# or a requirements.txt.
declares_python_dependencies() {
  grep -qsE '^\[(project|tool\.poetry|tool\.pdm)\]' pyproject.toml || [ -f requirements.txt ]
}

# Imports that no dependency provides, dependencies nothing imports, and imports
# of packages that only arrive through another dependency. deptry maps packages
# to modules from installed metadata, so it reads the project's environment.
deptry_check() {
  local site_packages
  site_packages="$(python -c 'import site; print(":".join(site.getsitepackages()))')"
  # Each flag replaces a project setting that could hide a finding.
  local deptry_overrides=(
    # Ignored rules: only DEP000, which does not exist.
    --ignore DEP000
    # Packages ignored for each rule: none.
    --per-rule-ignores DEP000=none
    # Paths excluded on top of the defaults: a pattern no path matches.
    --extend-exclude '^$'
    # Paths excluded: deptry's defaults.
    --exclude 'venv|\.venv|\.direnv|tests|\.git|setup\.py'
  )
  env PYTHONPATH="$site_packages" pipx run deptry==0.25.1 . "${deptry_overrides[@]}"
}

# Functions nothing reaches, from main packages and tests. deadcode reports
# without failing, so anything it prints fails. Go's own notices, such as a
# toolchain switch, go to stderr and do not count.
deadcode_check() {
  local out
  out="$(go run golang.org/x/tools/cmd/deadcode@v0.52.0 -test ./...)" || return 1
  echo "$out"
  [ -z "$out" ]
}

# Tracked files that every check leaves out, given the files they check.
# comm -23 prints the lines only the first list has.
left_out_files() {
  comm -23 <(git ls-files | sort) <(printf '%s\n' "$@" | sort)
}

# Unused files, exports and types, imports of packages the manifest does not
# list, duplicate exports and import cycles. An entry point written as a pattern
# fails the check, and knip still runs without it. Takes the files every check reads.
knip_check() {
  local config="$PWD/knip.pr-verify.json" ignored status=0
  remember_written "$config"
  mapfile -t ignored < <(left_out_files "$@")
  node "$here/knip-config.mjs" "$config" "${ignored[@]}" || status=1
  "$here/node_modules/.bin/knip" --config "$config" --no-progress --no-config-hints \
    --include files,unlisted,unresolved,exports,types,nsExports,nsTypes,enumMembers,duplicates,cycles \
    || status=1
  return "$status"
}

# Runs each dead code and dependency check the project's languages need.
dead_code_checks() {
  local -a python typescript javascript
  mapfile -t python < <(python_files "$@")
  mapfile -t typescript < <(typescript_files "$@")
  mapfile -t javascript < <(javascript_files "$@")

  if any "${python[@]}" && declares_python_dependencies; then
    run "deptry" deptry_check
  fi
  if [ -f go.mod ]; then
    run "go mod tidy" go mod tidy -diff
    run "deadcode" deadcode_check
  fi
  if [ -f package.json ] && any "${typescript[@]}" "${javascript[@]}"; then
    run "knip" knip_check "$@"
  fi
}
