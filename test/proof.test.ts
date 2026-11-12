import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  recheckDemonstration,
  runStaticAnalysis,
  verifyDemonstration,
  verifyStaticAnalysisFix,
} from "../src/proof.js";
import { FIX_SRC, LIMITS, repoAt, TEST, TEST_PATCH } from "./proof-fixtures.js";

describe("recheckDemonstration", () => {
  it("passes once the bug is fixed, wherever the fix landed", async () => {
    expect(
      await recheckDemonstration(repoAt(2), TEST_PATCH, LIMITS),
    ).toMatchObject({ result: "passes", runs: 1 });
  });

  it("fails while the bug is still there", async () => {
    expect(
      await recheckDemonstration(repoAt(1), TEST_PATCH, LIMITS),
    ).toMatchObject({ result: "fails", runs: 1 });
  });

  it("uses the test as it stands when the author committed it", async () => {
    const checkout = repoAt(2, { "tests/value.test.js": TEST });
    expect(
      await recheckDemonstration(checkout, TEST_PATCH, LIMITS),
    ).toMatchObject({
      result: "passes",
      runs: 1,
    });
  });

  it("is unusable when the test no longer fits the checkout, and leaves the checkout clean", async () => {
    const checkout = repoAt(2, { "tests/value.test.js": "something else\n" });
    expect(
      await recheckDemonstration(checkout, TEST_PATCH, LIMITS),
    ).toMatchObject({
      result: "unusable",
      runs: 0,
    });
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: checkout.root,
      }).toString(),
    ).toBe("");
  });

  it("never runs a patch read back from a comment that breaks the test-patch policy", async () => {
    const checkout = repoAt(1);
    expect(await recheckDemonstration(checkout, FIX_SRC, LIMITS)).toEqual({
      result: "unusable",
      runs: 0,
      durationMs: 0,
    });
  });
});

describe("verifyStaticAnalysisFix", () => {
  const fixTo = (value: number) => ({
    id: 1,
    kind: "fix" as const,
    description: "fix",
    diff: `diff --git a/value.js b/value.js\n--- a/value.js\n+++ b/value.js\n@@ -1,1 +1,1 @@\n-module.exports = 1;\n+module.exports = ${String(value)};\n`,
  });

  it("verifies a fix that clears every finding and keeps the suite passing", async () => {
    const checkout = repoAt(1, { "tests/value.test.js": TEST });
    expect(
      await verifyStaticAnalysisFix(checkout, fixTo(2), () =>
        Promise.resolve(0),
      ),
    ).toMatchObject({ fixPasses: true, findingsLeft: 0, runs: 1 });
  });

  it("does not run the suite while findings are left", async () => {
    const checkout = repoAt(1, { "tests/value.test.js": TEST });
    expect(
      await verifyStaticAnalysisFix(checkout, fixTo(2), () =>
        Promise.resolve(2),
      ),
    ).toMatchObject({ fixPasses: false, findingsLeft: 2, runs: 0 });
  });

  it("rejects a fix that clears the findings but breaks the suite, and leaves the checkout clean", async () => {
    const checkout = repoAt(1, { "tests/value.test.js": TEST });
    expect(
      await verifyStaticAnalysisFix(checkout, fixTo(3), () =>
        Promise.resolve(0),
      ),
    ).toMatchObject({ fixPasses: false, findingsLeft: 0, runs: 1 });
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: checkout.root,
      }).toString(),
    ).toBe("");
  });

  it("says nothing about findings when Semgrep failed or the fix did not apply", async () => {
    const checkout = repoAt(1);
    expect(
      await verifyStaticAnalysisFix(checkout, fixTo(2), () =>
        Promise.resolve(null),
      ),
    ).toMatchObject({ fixPasses: false, findingsLeft: null });
    expect(
      await verifyStaticAnalysisFix(repoAt(5), fixTo(2), () =>
        Promise.resolve(0),
      ),
    ).toMatchObject({ fixPasses: false, findingsLeft: null, runs: 0 });
  });
});

// Real Semgrep, from the pinned image CI sets. A local rule keeps the test off the registry.
describe.runIf(process.platform === "linux" && process.env.SEMGREP_IMAGE)(
  "runStaticAnalysis",
  () => {
    const RULES =
      "rules:\n  - id: no-eval\n    languages: [javascript]\n    severity: ERROR\n    message: eval\n    pattern: eval($X)\n";
    const analysis = {
      image: process.env.SEMGREP_IMAGE ?? "",
      args: "--config /src/rules.yml --disable-nosem",
    };

    it("counts findings, including ones an inline nosemgrep comment would hide", async () => {
      const checkout = repoAt(1, {
        "rules.yml": RULES,
        "a.js":
          "eval(process.argv[2]);\n// nosemgrep\neval(process.argv[3]);\n",
      });
      expect(
        await runStaticAnalysis(checkout, analysis, 120_000),
      ).toMatchObject({
        findings: 2,
      });
    }, 180_000);

    it("scans a file the fix added, which git does not track yet", async () => {
      const checkout = repoAt(1, { "rules.yml": RULES });
      const added =
        "diff --git a/b.js b/b.js\nnew file mode 100644\n--- /dev/null\n+++ b/b.js\n@@ -0,0 +1,1 @@\n+eval(process.argv[2]);\n";
      expect((await checkout.apply(added)).applied).toBe(true);
      expect(
        await runStaticAnalysis(checkout, analysis, 120_000),
      ).toMatchObject({
        findings: 1,
      });
      await checkout.reset();
    }, 180_000);
  },
);

// Compiles every test file without running it, the way a TypeScript build type-checks tests.
const BUILD =
  "for (const f of require('fs').readdirSync('tests')) new (require('vm').Script)(require('fs').readFileSync('tests/' + f, 'utf8'));\n";
const BROKEN_TEST_PATCH =
  "diff --git a/tests/broken.test.js b/tests/broken.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/broken.test.js\n@@ -0,0 +1,1 @@\n+this is not javascript(\n";

describe("a test patch that breaks the build", () => {
  const broken = {
    id: 1,
    kind: "test" as const,
    description: "broken",
    diff: BROKEN_TEST_PATCH,
  };

  it("does not count as a failing test", async () => {
    const checkout = repoAt(2, { "build.js": BUILD }, "node build.js");
    expect(
      (await verifyDemonstration(checkout, broken, undefined)).testFails,
    ).toBe(false);
  });

  it("makes a recheck unusable rather than still failing", async () => {
    const checkout = repoAt(2, { "build.js": BUILD }, "node build.js");
    expect(
      await recheckDemonstration(checkout, BROKEN_TEST_PATCH, LIMITS),
    ).toMatchObject({ result: "unusable", runs: 1 });
  });
});
