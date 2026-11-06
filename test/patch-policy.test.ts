import { describe, expect, it } from "vitest";
import {
  checkPatchPolicy,
  isDependencyFile,
  isTestPath,
} from "../src/patch-policy.js";
import { FIX_SRC, LIMITS, patch } from "./harness-fixtures.js";

const ADD_TEST = patch(
  "test/order.test.ts",
  `@@ -0,0 +1,2 @@\n+import { total } from '../src/order';\n+test('x', () => expect(total([])).toBe(0));\n`,
  { newFile: true },
);
const EXTEND_TEST = patch(
  "test/order.test.ts",
  `@@ -3,2 +3,3 @@\n test('a', () => {});\n+test('b', () => {});\n test('c', () => {});\n`,
);
const EDIT_TEST = patch(
  "test/order.test.ts",
  `@@ -3,2 +3,2 @@\n-test('a', () => {});\n+test('a2', () => {});\n test('c', () => {});\n`,
);

describe("isTestPath", () => {
  it("recognises test directories and test-named files across ecosystems", () => {
    for (const p of [
      "test/a.ts",
      "src/__tests__/a.js",
      "pkg/spec/a_spec.rb",
      "a.test.tsx",
      "b.spec.mjs",
      "c_test.go",
      "test_d.py",
      "e_test.py",
      "FooTests.cs",
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it("does not match production code or look-alikes", () => {
    for (const p of [
      "src/order.ts",
      "src/testing-utils/contest.ts",
      "latest.ts",
      "protest.go",
      "src/attestation.py",
    ]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe("isDependencyFile", () => {
  it("matches manifests and lockfiles anywhere in the tree", () => {
    for (const p of [
      "package.json",
      "packages/a/package-lock.json",
      "go.mod",
      "requirements-dev.txt",
      "pyproject.toml",
      "Cargo.lock",
      "Api.csproj",
    ]) {
      expect(isDependencyFile(p), p).toBe(true);
    }
    expect(isDependencyFile("src/package.ts")).toBe(false);
  });
});

describe("checkPatchPolicy", () => {
  it("accepts a new test file as a test patch", () => {
    expect(checkPatchPolicy(ADD_TEST, "test", LIMITS)).toMatchObject({
      ok: true,
      violations: [],
    });
  });

  it("accepts a plain unified diff without git headers", () => {
    const plain =
      "--- /dev/null\n+++ b/test/order.test.ts\n@@ -0,0 +1,1 @@\n+test('x', () => {});\n";
    expect(checkPatchPolicy(plain, "test", LIMITS)).toMatchObject({
      ok: true,
      violations: [],
    });
  });

  it("accepts additions to an existing test file but not edits", () => {
    expect(checkPatchPolicy(EXTEND_TEST, "test", LIMITS).ok).toBe(true);
    const edit = checkPatchPolicy(EDIT_TEST, "test", LIMITS);
    expect(edit.ok).toBe(false);
    expect(edit.violations[0]).toMatch(/only add to an existing test file/);
  });

  it("rejects a test patch that touches production code", () => {
    const result = checkPatchPolicy(FIX_SRC, "test", LIMITS);
    expect(result.violations).toContain(
      "src/order.ts: a test patch may only touch test locations",
    );
  });

  it("accepts a fix in production code and rejects a fix that only touches tests", () => {
    expect(checkPatchPolicy(FIX_SRC, "fix", LIMITS).ok).toBe(true);
    expect(checkPatchPolicy(ADD_TEST, "fix", LIMITS).violations).toContain(
      "a fix patch that touches only tests is not a fix",
    );
  });

  it("rejects workflow files, dependency files, binaries, symlinks and paths outside the repo", () => {
    const workflow = patch(
      ".github/workflows/ci.yml",
      `@@ -1,1 +1,1 @@\n-a\n+b\n`,
    );
    expect(checkPatchPolicy(workflow, "fix", LIMITS).violations[0]).toMatch(
      /workflow files are off limits/,
    );

    const lock = patch("package-lock.json", `@@ -1,1 +1,1 @@\n-a\n+b\n`);
    expect(checkPatchPolicy(lock, "fix", LIMITS).violations[0]).toMatch(
      /dependency manifests/,
    );

    const binary = `diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n`;
    expect(checkPatchPolicy(binary, "fix", LIMITS).violations[0]).toMatch(
      /binary/,
    );

    const symlink = `diff --git a/src/link b/src/link\nnew file mode 120000\nindex 0..1\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+/etc/passwd\n`;
    expect(checkPatchPolicy(symlink, "fix", LIMITS).violations[0]).toMatch(
      /symlinks/,
    );

    const outside = patch("../outside.ts", `@@ -1,1 +1,1 @@\n-a\n+b\n`);
    expect(checkPatchPolicy(outside, "fix", LIMITS).violations[0]).toMatch(
      /outside the repository/,
    );
  });

  it("enforces the size limits", () => {
    const big = patch("src/a.ts", `@@ -1,0 +1,3 @@\n+a\n+b\n+c\n`);
    const result = checkPatchPolicy(big, "fix", { maxLines: 2, maxFiles: 6 });
    expect(result.violations).toContain(
      "patch changes 3 lines; the limit is 2",
    );

    const many = ["a", "b", "c"]
      .map((n) => patch(`src/${n}.ts`, `@@ -1,1 +1,1 @@\n-x\n+y\n`))
      .join("");
    expect(
      checkPatchPolicy(many, "fix", { maxLines: 200, maxFiles: 2 }).violations,
    ).toContain("patch touches 3 files; the limit is 2");
  });

  it("rejects a patch that edits a scanner ignore file", () => {
    const ignore = patch(".semgrepignore", "@@ -0,0 +1,1 @@\n+src/\n", {
      newFile: true,
    });
    expect(checkPatchPolicy(ignore, "fix", LIMITS).violations[0]).toMatch(
      /scanner ignore files are off limits/,
    );
  });

  it("rejects an empty patch", () => {
    expect(checkPatchPolicy("", "fix", LIMITS).violations).toContain(
      "patch contains no file changes",
    );
  });
});
