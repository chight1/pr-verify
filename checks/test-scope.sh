#!/usr/bin/env bash
# Runs run.sh with GATE_SCOPE=changes on a scratch project whose base commit
# fails many checks, as a large old codebase would: a clean change must pass,
# and a change that adds a problem, touches a function over the limits or makes
# a long file longer must fail on that alone. It downloads its tools, so it
# runs in CI.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
# shellcheck source=checks/test-helpers.sh
source "$here/test-helpers.sh"

# Commits a change on top of the base, as a pull request's checkout holds it.
commit_change() {
  git add -A
  git -c user.name=fixture -c user.email=fixture@example.test commit -qm change
}

mkdir "$scratch/legacy" && cd "$scratch/legacy"
git init -q
# Untyped, over the complexity and parameter limits, with debug output, and a
# shell command that Semgrep's rules find.
cat > legacy.py <<'PY'
import os
import subprocess


def run_command(command):
    return subprocess.run(command, shell=True, check=False)


def shipping_totals(orders, regions, carriers, discount, surcharge, limit):
    totals = []
    for order in orders:
        if order in regions:
            for carrier in carriers:
                if carrier and discount:
                    while len(totals) < limit:
                        if order > carrier:
                            totals.append(surcharge)
                        elif order < carrier:
                            totals.append(discount)
                        else:
                            break
    return totals


print(os.name)
PY
{
  echo '"""A file over the length limit."""'
  for line in $(seq 409); do echo "STEP_$line = $line"; done
} > long.py
printf '#!/usr/bin/env bash\ncd %s\n' "\$1" > legacy.sh
commit_base "$scratch/event.json"
export GATE_SCOPE=changes

# A clean function added to the old file.
printf '\n\ndef doubled(count: int) -> int:\n    """Twice the count."""\n    return count * 2\n' >> legacy.py
commit_change
if ! output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh failed on a clean change to old code"
fi
if [ -e pyrightconfig.pr-verify.json ]; then
  fail "run.sh left the config it wrote for pyright behind"
fi
if output="$(GATE_SCOPE=repository bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on the old code with every file checked"
fi
export SEMGREP_ARGS="--config p/python --disable-nosem"
if ! output="$(bash "$here/static-analysis.sh" 2>&1)"; then
  fail "static analysis failed on a clean change to old code"
fi
if output="$(GATE_SCOPE=repository bash "$here/static-analysis.sh" 2>&1)"; then
  fail "static analysis passed on the old code with every file checked"
fi

# An unused import added, a line of the over-complex function changed, and the
# long file made longer. The old debug output is on a line the change leaves.
sed -i '1i import sys' legacy.py
sed -i 's/^    totals = /    totals: list[int] = /' legacy.py
echo "STEP_410 = 410" >> long.py
commit_change
if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on a change that adds a problem to old code"
fi
expect_names "::error title=ruff check::" F401 PLR0913 "::error title=complexipy::" shipping_totals \
  "long.py has 411 lines"
for legacy_finding in T201 SC2164; do
  if grep -qF "$legacy_finding" <<< "$output"; then
    fail "run.sh counted $legacy_finding, on a line the change leaves alone"
  fi
done

# A new shell command, on a changed line, which static analysis must count.
printf '\n\ndef run_script(script: str) -> object:\n    """Runs a script."""\n    return subprocess.run(script, shell=True, check=False)\n' \
  >> legacy.py
commit_change
if output="$(bash "$here/static-analysis.sh" 2>&1)"; then
  fail "static analysis passed on a new shell command in changed code"
fi
expect_names "legacy.py:" shell
# The old command is on line 7, below the three imports and run_command's def.
if grep -qF "legacy.py:7:" <<< "$output"; then
  fail "static analysis counted the old shell command, on a line the change leaves alone"
fi

# Outside a pull request there is no base to compare with.
if output="$(GITHUB_EVENT_PATH="" bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed with gate-scope changes outside a pull request"
fi
expect_names "gate-scope: changes needs a pull request"
echo "changed-code checks: ok"
