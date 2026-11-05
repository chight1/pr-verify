#!/usr/bin/env bash
# Runs run.sh on a scratch project of badly formatted files whose own configs
# try to loosen every check, then again once each formatter has fixed them.
# It downloads its tools, so it runs in CI rather than in the sandboxed suite.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(mktemp -d)"
trap 'rm -rf "$project"' EXIT
cd "$project"

git init -q
printf 'x=1\n' > app.py
printf 'package main\nfunc main(){}\n' > main.go
printf 'const a = {b:1}\n' > app.ts
printf '*  item\n' > notes.md
printf '<ul><li>one</li><li>two</li></ul>\n' > page.html
printf '<div>\n{%% if x %%}\n<p>{{ x }}</p>\n{%% endif %%}\n</div>\n' > template.html
# Machine-written files are left alone.
printf '{"lockfileVersion":3}\n' > package-lock.json
printf 'const   gen=1\n' > generated.js
printf 'generated.js linguist-generated=true\n' > .gitattributes
# The project's own settings, which must have no effect.
printf '{"printWidth": 500, "semi": false}\n' > .prettierrc
printf '*\n' > .prettierignore
printf '[tool.ruff]\nexclude = ["*"]\n[tool.djlint]\nignore = "H006,T001,H025"\n' > pyproject.toml
printf 'root = true\n[*]\nmax_line_length = 500\n' > .editorconfig
git add -A

expect_names() {
  local output="$1"
  shift
  for name in "$@"; do
    grep -qF "$name" <<< "$output" || { echo "expected the output to name $name" >&2; exit 1; }
  done
}

if output="$(bash "$here/run.sh" 2>&1)"; then
  echo "$output"
  echo "run.sh passed on unformatted files" >&2
  exit 1
fi
expect_names "$output" app.py main.go app.ts notes.md page.html template.html
for name in generated.js package-lock.json; do
  if grep -qF "$name" <<< "$output"; then
    echo "$output"
    echo "run.sh checked the machine-written $name" >&2
    exit 1
  fi
done

pipx run ruff==0.17.2 format --isolated -q app.py
gofmt -w main.go
pipx run djlint==1.47.1 --reformat --profile=jinja --quiet template.html || true
"$here/node_modules/.bin/prettier" --write --no-config --no-editorconfig --ignore-path /dev/null \
  app.ts notes.md page.html > /dev/null
git add -A

if ! output="$(bash "$here/run.sh" 2>&1)"; then
  echo "$output"
  echo "run.sh failed on formatted files" >&2
  exit 1
fi
echo "checks: ok"
