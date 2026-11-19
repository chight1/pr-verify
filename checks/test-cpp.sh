#!/usr/bin/env bash
# Runs run.sh, and run.sh online, on scratch C++ projects whose own configs try
# to loosen every check: one with no compile commands and a badly formatted
# file, which must fail and then pass once both are fixed, and one of lint,
# size, dead code, test and dependency problems, some hidden behind
# suppression comments, which must fail at every tool. It needs GoogleTest's
# headers, which CI installs, and downloads its tools, so it runs in CI.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
# shellcheck source=checks/test-helpers.sh
source "$here/test-helpers.sh"

# The project's own settings, which must have no effect, and a build directory
# git ignores, as CMake's is.
start_project() {
  mkdir "$scratch/$1" && cd "$scratch/$1"
  git init -q
  printf 'BasedOnStyle: WebKit\nDisableFormat: true\n' > .clang-format
  printf '*\n' > .clang-format-ignore
  printf 'Checks: "-*"\n' > .clang-tidy
  printf 'build/\n' > .gitignore
  mkdir src tests
}

# build/compile_commands.json as CMake writes it, for the given source files.
write_compile_commands() {
  local file entries=()
  for file in "$@"; do
    entries+=("{\"directory\": \"$PWD\", \"command\": \"/usr/bin/g++ -std=c++20 -Isrc -c $file\", \"file\": \"$file\"}")
  done
  mkdir -p build
  (
    IFS=,
    printf '[%s]\n' "${entries[*]}"
  ) > build/compile_commands.json
}

start_project format
# A header with #pragma once and a plain struct, and a tool's main, which
# CMake does not list, writing its report to std::cout.
cat > src/order.h <<'CPP'
#pragma once

#include <vector>

namespace order {

// A price, in cents.
struct Price {
  int cents = 0;

  [[nodiscard]] bool IsFree() const { return cents == 0; }
};

// The sum of the given prices, in cents.
[[nodiscard]] int Total(const std::vector<int>& prices);

}  // namespace order
CPP
cat > src/main.cpp <<'CPP'
#include <iostream>

#include "order.h"

int main() {
  std::cout << order::Total({}) << '\n';
  return 0;
}
CPP
printf '#include "order.h"\n#include <numeric>\n#include <vector>\nnamespace order {\n' > src/order.cpp
printf 'int Total(const std::vector<int>&prices){return std::accumulate(prices.begin(),prices.end(),0);}\n}\n' \
  >> src/order.cpp
cat > tests/order_test.cpp <<'CPP'
#include <gtest/gtest.h>

#include "order.h"

namespace {

TEST(OrderTest, TotalOfNoPricesIsZero) {
  EXPECT_EQ(order::Total({}), 0);
}

TEST(OrderTest, NoCentsIsFree) {
  EXPECT_TRUE(order::Price{}.IsFree());
}

}  // namespace
CPP
git add -A

if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed with no compile commands and an unformatted file"
fi
expect_names "No compile_commands.json" "::error title=clang-format::" order.cpp

write_compile_commands src/order.cpp tests/order_test.cpp
pipx run clang-format==23.1.5 --style="file:$here/clang-format.yml" -i src/order.h src/order.cpp \
  src/main.cpp tests/order_test.cpp
git add -A
if ! output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh failed on clean, formatted C++"
fi

start_project lint
commit_base "$scratch/event.json"
# A magic number behind clang-tidy's suppression comment, a warning turned off
# by a pragma, and functions nothing calls, with a vague name, debug output, a
# task comment with no issue and commented-out code.
cat > src/lint.cpp <<'CPP'
#include <iostream>

// NOLINTNEXTLINE(readability-magic-numbers)
int Scaled(int count) { return count * 42; }

#pragma GCC diagnostic ignored "-Wshadow"

int Unused() {
  int tmp = 7;
  std::cout << tmp << '\n';
  // Scaled(tmp);
  return tmp;
}
CPP
printf '// %s: make this faster\n' TODO >> src/lint.cpp
# Over every size and complexity limit: too many parameters, too deep, too
# complex, and too long.
cat > src/complex.cpp <<'CPP'
int Tangle(int first, int second, int third, int fourth, int fifth, int sixth) {
  int total = 0;
  for (int outer = 0; outer < first; ++outer) {
    if (outer > second || outer == third) {
      for (int inner = 0; inner < third; ++inner) {
        if (inner > fourth && outer > fifth && inner != outer && total != first) {
          if (total > sixth) {
            --total;
          } else if (total < sixth) {
            ++total;
          } else {
            break;
          }
        }
      }
    }
  }
  return total;
}
CPP
{
  echo "int Long() {"
  echo "  int steps = 0;"
  for _ in $(seq 55); do echo "  steps += 1;"; done
  echo "  return steps;"
  echo "}"
} >> src/complex.cpp
# A test GoogleTest never runs, and one that checks nothing.
cat > tests/skipped_test.cpp <<'CPP'
#include <gtest/gtest.h>

TEST(Waiting, DISABLED_Waits) { EXPECT_TRUE(true); }

TEST(Waiting, ChecksNothing) {
  const int count = 1;
  static_cast<void>(count);
}
CPP
write_compile_commands src/lint.cpp src/complex.cpp tests/skipped_test.cpp
# A port and a package no registry has, and a locked version ConanCenter does
# not have, which fail, beside old ones that pass. Skipped: a port kept in the
# repository, one from a registry vcpkg-configuration.json names, and a Conan
# package with a user and channel, which ConanCenter never publishes.
printf '{"dependencies": ["fmt", "pr-verify-fixture-made-up-port", "company-logging", "company-metrics"]}\n' \
  > vcpkg.json
printf '{"registries": [{"kind": "filesystem", "path": "/opt/ports", "packages": ["company-metrics"]}]}\n' \
  > vcpkg-configuration.json
mkdir -p ports/company-logging
printf 'vcpkg_minimum_required(VERSION 2024-01-01)\n' > ports/company-logging/portfile.cmake
printf '[requires]\nzlib/1.3.1\npr-verify-fixture-made-up-conan/1.0\ncompany-only/1.0@company/stable\n' \
  > conanfile.txt
printf '{"version": "0.5", "requires": ["zlib/99.0#0123%%1700000000"]}\n' > conan.lock
git add -A

if output="$(bash "$here/run.sh" 2>&1)"; then
  fail "run.sh passed on C++ lint, size and test problems"
fi
if online="$(bash "$here/run.sh" online 2>&1)"; then
  fail "run.sh online passed on made-up C++ dependencies"
fi
output+="$online"
for tool in clang-tidy lizard cppcheck "commented-out code" "task comments" Semgrep suppressions \
  "new dependencies"; do
  expect_names "::error title=$tool::"
done
expect_names readability-magic-numbers readability-function-size readability-function-cognitive-complexity \
  unusedFunction Tangle vague-name-cpp debug-output-cpp unconditional-skip-cpp test-without-assertion-cpp \
  "// Scaled(tmp);" NOLINTNEXTLINE "#pragma GCC diagnostic ignored" \
  "pr-verify-fixture-made-up-port (vcpkg) is not on its registry" \
  "pr-verify-fixture-made-up-conan (conan) is not on its registry" \
  "zlib@99.0#0123 (conan) is not on its registry"
for name in "fmt (vcpkg)" "zlib (conan)" "company-logging (" "company-metrics (" "company-only ("; do
  if grep -qF "$name" <<< "$output"; then
    fail "the dependency check failed or looked up $name, which it should pass or skip"
  fi
done
echo "C++ checks: ok"
