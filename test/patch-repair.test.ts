import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff.js";
import { applyHints, recountHunks } from "../src/patch-repair.js";
import { SAMPLE } from "./diff-fixtures.js";

describe("recountHunks", () => {
  it("leaves git diff output unchanged", () => {
    expect(recountHunks(SAMPLE)).toBe(`${SAMPLE.trimEnd()}\n`);
  });

  it("corrects overstated and understated counts from the hunk body", () => {
    const sent = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -10,9 +10,38 @@ def f():",
      " one",
      "+two",
      " three",
      "diff --git a/b.py b/b.py",
      "--- a/b.py",
      "+++ b/b.py",
      "@@ -1 +1 @@",
      "-x",
      "-y",
      "+z",
      " w",
      "",
    ].join("\n");
    const fixed = recountHunks(sent);
    expect(fixed).toContain("@@ -10,2 +10,3 @@ def f():\n");
    expect(fixed).toContain("@@ -1,3 +1,2 @@\n");
    expect(parseDiff(fixed).map((f) => [f.path, f.added, f.removed])).toEqual([
      ["a.py", 1, 0],
      ["b.py", 1, 2],
    ]);
  });

  it("splits a plain multi-file diff at the next file header and drops trailing blank lines", () => {
    const sent = [
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -1,7 +1,7 @@",
      "-a",
      "+b",
      "",
      "",
      "--- a/c.py",
      "+++ b/c.py",
      "@@ -3,1 +3,1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    expect(recountHunks(sent)).toBe(
      [
        "--- a/a.py",
        "+++ b/a.py",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+b",
        "--- a/c.py",
        "+++ b/c.py",
        "@@ -3,1 +3,1 @@",
        "-c",
        "+d",
        "",
      ].join("\n"),
    );
  });

  it("applies with git once recounted", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "pr-verify-recount-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
    // Model-written: the header claims 9 new lines where the body has 5.
    const sent =
      "--- a/a.txt\n+++ b/a.txt\n@@ -1,4 +1,9 @@\n one\n two\n+inserted\n three\n four\n";
    writeFileSync(path.join(dir, "sent.diff"), sent);
    writeFileSync(path.join(dir, "fixed.diff"), recountHunks(sent));
    expect(() => git("apply", "--check", "sent.diff")).toThrow();
    expect(() => git("apply", "--check", "fixed.diff")).not.toThrow();
  });
});

describe("applyHints", () => {
  it("names a hunk with leading context and no trailing context", () => {
    const patch = recountHunks(
      "--- a/s.py\n+++ b/s.py\n@@ -42,4 +42,6 @@\n def f():\n     return 1\n \n \n+def g():\n+    return 2\n",
    );
    expect(applyHints(patch)).toEqual([
      "s.py: the hunk at old line 42 has 4 context line(s) before its change and none after. git applies a hunk like that only at the end of a file. Add the lines that follow the change as context.",
    ]);
  });

  it("says nothing about well-formed hunks", () => {
    expect(applyHints(SAMPLE)).toEqual([]);
  });
});
