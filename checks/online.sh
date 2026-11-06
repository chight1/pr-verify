#!/usr/bin/env bash
# The gate's checks that look things up on GitHub with the workflow's token, run
# on the project in the working directory. The gate runs them before its install
# step, the first to run the project's code, so no process the project starts is
# alive to read the token. Each check runs even when an earlier one fails, and
# the script fails at the end if any did.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/common.sh
source "$here/common.sh"

mapfile -t files < <(written_files)
mapfile -t workflows < <(printf '%s\n' "${files[@]}" | grep -E '^\.github/workflows/[^/]+\.ya?ml$')
mapfile -t actions < <(printf '%s\n' "${files[@]}" | grep -E '(^|/)action\.ya?ml$')

# zizmor's online audits look up the actions a workflow uses.
if [ $((${#workflows[@]} + ${#actions[@]})) -gt 0 ]; then
  run "zizmor" pipx run zizmor==1.31.1 --config "$here/zizmor.yml" --no-ignores --no-progress \
    "${workflows[@]}" "${actions[@]}"
fi

finish "Online checks"
