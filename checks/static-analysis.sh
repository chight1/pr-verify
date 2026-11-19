#!/usr/bin/env bash
# The gate's static analysis: Semgrep's maintained rules for the runtime, from
# SEMGREP_ARGS, run from the image SEMGREP_IMAGE names, both of which the
# workflow defines. MODE is security-scan's strict or loose, which SEMGREP_ARGS
# already reflects. With GATE_SCOPE=changes, Semgrep scans the files the pull
# request changes and only findings on changed lines count, as in run.sh.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=checks/checked-files.sh
source "$here/checked-files.sh"

case "${MODE:-strict}" in
  strict | loose) ;;
  *)
    echo "security-scan must be strict or loose, not '$MODE'" >&2
    exit 1
    ;;
esac
scope="${GATE_SCOPE:-repository}"
case "$scope" in
  repository | changes) ;;
  *)
    echo "gate-scope must be repository or changes, not '$scope'" >&2
    exit 1
    ;;
esac

read -ra rules <<< "${SEMGREP_ARGS:?SEMGREP_ARGS must name the Semgrep rules for the runtime}"
semgrep_image="${SEMGREP_IMAGE:-$(sed -n 's/^  SEMGREP_IMAGE: //p' "$here/../.github/workflows/pr-verify.yml")}"

semgrep_scan() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/src" -w /src "$semgrep_image" \
    semgrep scan "${rules[@]}" --error --metrics off --disable-version-check "$@"
}

if [ "$scope" = repository ]; then
  semgrep_scan
  exit
fi

mapfile -t files < <(written_files)
changed="$(python3 "$here/changed_code.py" files "${files[@]}")" || exit 1
mapfile -t changed_files < <(grep -v '^$' <<< "$changed")
if ! any "${changed_files[@]}"; then
  echo "The pull request changes no files for Semgrep to scan."
  exit 0
fi
# One finding to a line, with its file and line, for the filter to read.
output="$(mktemp)"
semgrep_scan --emacs -- "${changed_files[@]}" > "$output" 2>&1
status=$?
python3 "$here/changed_code.py" filter Semgrep "$status" < "$output"
status=$?
rm -f "$output"
exit "$status"
