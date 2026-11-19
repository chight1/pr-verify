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

mkdir "$scratch/legacy" && cd "$scratch/legacy"
git init -q
# Untyped, over the complexity and parameter limits, with debug output.
cat > legacy.py <<'PY'
import os


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
git add -A
if ! output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh failed on a clean change to old code"
fi
if output="$(GATE_SCOPE=repository bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on the old code with every file checked"
fi

# An unused import added, a line of the over-complex function changed, and the
# long file made longer. The old debug output is on a line the change leaves.
sed -i '1i import sys' legacy.py
sed -i 's/^    totals = /    totals: list[int] = /' legacy.py
echo "STEP_410 = 410" >> long.py
git add -A
if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on a change that adds a problem to old code"
fi
expect_names "::error title=ruff check::" F401 C901 PLR0913 "::error title=complexipy::" shipping_totals \
  "long.py has 411 lines"
for legacy_finding in T201 SC2164; do
  if grep -qF "$legacy_finding" <<< "$output"; then
    fail "run.sh counted $legacy_finding, on a line the change leaves alone"
  fi
done

# Outside a pull request there is no base to compare with.
if output="$(GITHUB_EVENT_PATH="" bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed with gate-scope changes outside a pull request"
fi
expect_names "gate-scope: changes needs a pull request"
echo "changed-code checks: ok"
