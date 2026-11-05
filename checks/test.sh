#!/usr/bin/env bash
# Runs run.sh on scratch projects whose own configs try to loosen every check:
# one of badly formatted files, which must fail and then pass once each
# formatter has fixed them, and one of lint and type errors hidden behind
# suppression comments, which must fail at every tool.
# It downloads its tools, so it runs in CI rather than in the sandboxed suite.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail() {
  echo "$output"
  echo "$1" >&2
  exit 1
}

expect_names() {
  for name in "$@"; do
    grep -qF -- "$name" <<< "$output" || fail "expected the output to name $name"
  done
}

# The project's own settings, which must have no effect.
loosen() {
  printf '{"printWidth": 500, "semi": false}\n' > .prettierrc
  printf '*\n' > .prettierignore
  printf 'root = true\n[*]\nmax_line_length = 500\n' > .editorconfig
  printf '[tool.ruff]\nexclude = ["*"]\n[tool.ruff.lint]\nselect = []\n' > pyproject.toml
  printf '[tool.pyright]\ntypeCheckingMode = "off"\n[tool.djlint]\nignore = "H006,T001,H025"\n' >> pyproject.toml
  printf '{"compilerOptions": {"strict": false, "noImplicitAny": false, "noCheck": true}}\n' > tsconfig.json
  printf 'export default [];\n' > eslint.config.js
  printf 'version: "2"\nlinters:\n  default: none\n' > .golangci.yml
  printf 'module example.com/fixture\n\ngo 1.22\n' > go.mod
}

mkdir "$scratch/format" && cd "$scratch/format"
git init -q
loosen
printf 'x=1\n' > app.py
# A package that imports itself by absolute path, which pyright must resolve from the project root.
mkdir pkg && : > pkg/__init__.py
printf 'X = 1\n' > pkg/models.py
printf 'from pkg.models import X\n\nY = X\n' > pkg/views.py
printf '// Package main is a fixture.\npackage main\nfunc main(){}\n' > main.go
printf 'export const a = {b:1}\n' > app.ts
printf '*  item\n' > notes.md
printf '<ul><li>one</li><li>two</li></ul>\n' > page.html
printf '<div>\n{%% if x %%}\n<p>{{ x }}</p>\n{%% endif %%}\n</div>\n' > template.html
# Machine-written files are left alone.
printf '{"lockfileVersion":3}\n' > package-lock.json
printf 'const   gen=1\n' > generated.js
printf 'generated.js linguist-generated=true\n' > .gitattributes
git add -A

if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on unformatted files"
fi
expect_names app.py main.go app.ts notes.md page.html template.html
for name in generated.js package-lock.json; do
  if grep -qF "$name" <<< "$output"; then
    fail "run.sh checked the machine-written $name"
  fi
done

pipx run ruff==0.17.2 format --isolated -q app.py
gofmt -w main.go
pipx run djlint==1.47.1 --reformat --profile=jinja --quiet template.html || true
"$here/node_modules/.bin/prettier" --write --no-config --no-editorconfig --ignore-path /dev/null \
  app.ts notes.md page.html .prettierrc tsconfig.json > /dev/null
git add -A

if ! output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh failed on formatted files"
fi

mkdir "$scratch/lint" && cd "$scratch/lint"
git init -q
loosen
# Each tool's own suppression comment, which the gate ignores or rejects.
printf 'def double(x):  # noqa\n    return x * 2  # type: ignore\n' > lint.py
printf '/* eslint-disable */\nexport function half(n) {\n  return n / 2;\n}\n' > lint.ts
printf '// @ts-ignore\nexport const loose: any = "text";\n' >> lint.ts
printf 'var count = 1;\nexport { count };\n' > lint.js
printf '// Package main is a fixture.\npackage main\n\nimport "os"\n\nfunc main() {\n\tos.Remove("x")\n}\n' > main.go
# The comments the gate rejects outright, written so this file has none of them.
printf 'x = 1  # pyright%s basic\n' ':' > suppressed.py
printf '// prettier%signore\nexport const y = 1;\n' '-' > suppressed.ts
git add -A

if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on lint and type errors"
fi
for tool in "ruff check" pyright tsc ESLint golangci-lint suppressions; do
  expect_names "::error title=$tool::"
done
expect_names ANN001 reportMissingParameterType TS7006 no-explicit-any ban-ts-comment no-var \
  errcheck suppressed.py suppressed.ts
echo "checks: ok"
