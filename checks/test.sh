#!/usr/bin/env bash
# Runs run.sh, and run.sh online, on scratch projects whose own configs try to
# loosen every check: one of badly formatted files, which must fail and then pass
# once each formatter has fixed them, and one of lint and type errors hidden
# behind suppression comments, which must fail at every tool.
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
  {
    printf '[project]\nname = "fixture"\nversion = "0"\ndependencies = []\n'
    printf '[tool.ruff]\nexclude = ["*"]\n[tool.ruff.lint]\nselect = []\n'
    printf '[tool.deptry]\nignore = ["DEP001"]\n'
    printf '[tool.pyright]\ntypeCheckingMode = "off"\n[tool.djlint]\nignore = "H006,T001,H025"\n'
  } > pyproject.toml
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
printf '{\n  "name": "fixture",\n  "private": true\n}\n' > package.json
printf '{ "entry": ["app.ts", "eslint.config.js"] }\n' > knip.json
printf '*  item\n' > notes.md
printf '<ul><li>one</li><li>two</li></ul>\n' > page.html
printf '<div>\n{%% if x %%}\n<p>{{ x }}</p>\n{%% endif %%}\n</div>\n' > template.html
# Machine-written files are left alone.
printf '{"lockfileVersion":3}\n' > package-lock.json
printf 'const   gen=1\n' > generated.js
printf 'generated.js linguist-generated=true\n' > .gitattributes
# A clean workflow, the templates a project copies, and a clean shell script,
# which the every-project checks must pass.
mkdir -p .github/workflows
printf 'name: ci\non: push\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n' \
  > .github/workflows/ci.yml
cp "$here"/../templates/*.yml .github/workflows/
printf '#!/usr/bin/env bash\necho "ok"\n' > build.sh
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
if ! output="$(bash "$here/run.sh" online 2>&1)"; then
  fail "run.sh online failed on a clean workflow or a template"
fi

mkdir "$scratch/lint" && cd "$scratch/lint"
git init -q
loosen
# Each tool's own suppression comment, which the gate ignores or rejects.
printf 'import requests\n\n\ndef double(x):  # noqa\n    return x * 2  # type: ignore\n' > lint.py
printf '{\n  "name": "fixture",\n  "private": true\n}\n' > package.json
printf '{ "ignore": ["**"], "ignoreDependencies": ["left-pad"] }\n' > knip.json
printf '/* eslint-disable */\nimport "left-pad";\nexport function half(n) {\n  return n / 2;\n}\n' > lint.ts
printf '// @ts-ignore\nexport const loose: any = "text";\n' >> lint.ts
printf 'var count = 1;\nexport { count };\n' > lint.js
# The patterns agents leave behind: debug output, a magic number, a vague name,
# a task comment with no issue, and tests that are skipped or check nothing.
printf 'console.log(count);\nexport const later = setTimeout(() => count, 5000);\n' >> lint.js
printf '// %s: make this faster\nexport const data = 1;\n' TODO >> lint.ts
printf 'it.skip("waits", () => {});\nit("runs", () => {});\n' > lint.test.ts
printf 'data = 1\n' >> suppressed.py
printf 'import pytest\n\n\n@pytest.mark.skip(reason="later")\ndef test_skipped():\n    assert True\n\n\ndef test_nothing():\n    print(1)\n' > test_lint.py
printf 'package main\n\nimport "testing"\n\nfunc TestSkipped(t *testing.T) {\n\tt.Skip("later")\n}\n' > main_test.go
printf '// Package main is a fixture.\npackage main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tos.Remove("x")\n\t// %s: make this faster\n\tdata := len(os.Args) * 42\n\tfmt.Println(data)\n}\n\nfunc unused() {}\n' TODO > main.go
# The comments the gate rejects outright, written so this file has none of them.
printf 'x = 1  # pyright%s basic\n' ':' > suppressed.py
printf '// prettier%signore\nexport const y = 1;\n' '-' > suppressed.ts
printf '#!/usr/bin/env bash\ncd %s\n' "\$1" > deploy.sh
printf '#!/usr/bin/env bash\n# shellcheck%sdisable=SC2086\necho %s\n' ' ' "\$1" > suppressed.sh
# A workflow with an unpinned action and a script injection behind zizmor's ignore comment.
mkdir -p .github/workflows
printf 'name: ci\non: pull_request\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "%s" # zizmor: ignore[template-injection]\n      - run: echo %s\n' \
  "\${{ github.event.pull_request.title }}" "\$HOME" > .github/workflows/ci.yml
printf 'FROM ubuntu\n# hadolint ignore=DL3008\nRUN apt-get install curl\n' > Dockerfile
# CRLF, trailing whitespace and no final newline, in a file no formatter reads.
printf 'one\r\ntwo \nthree' > notes.txt
head -c 1100000 /dev/zero > big.bin
git add -A

if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on lint and type errors"
fi
if online="$(bash "$here/run.sh" online 2>&1)"; then
  fail "run.sh online passed on an unpinned action and a script injection"
fi
output+="$online"
for tool in "ruff check" pyright tsc ESLint golangci-lint deptry deadcode knip whitespace "file size" actionlint zizmor \
  shellcheck hadolint suppressions "task comments" "agent patterns"; do
  expect_names "::error title=$tool::"
done
expect_names ANN001 reportMissingParameterType TS7006 no-explicit-any ban-ts-comment no-var \
  errcheck DEP001 "unreachable func: unused" left-pad "Unused files" suppressed.py suppressed.ts suppressed.sh "LF line endings" "trailing whitespace" \
  "notes.txt: no newline" big.bin SC2086 SC2164 unpinned-uses template-injection DL3006 DL3008 \
  no-console pr-verify/no-magic-numbers id-match sonarjs/comment-regex vitest/no-disabled-tests \
  vitest/expect-expect forbidigo mnd vague-name-python vague-name-go unconditional-skip-python \
  unconditional-skip-go test-without-assertion-python test-without-assertion-go
echo "checks: ok"
