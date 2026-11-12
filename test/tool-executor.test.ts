import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { Budget } from "../src/budget.js";
import { Scrubber } from "../src/claude-context.js";
import { recountHunks } from "../src/patch-repair.js";
import type {
  ApplyResult,
  TestCheckout,
  TestRun,
} from "../src/test-checkout.js";
import { READ_FILE_LIMIT_LINES } from "../src/tool-definitions.js";
import { ToolExecutor } from "../src/tool-executor.js";

/** A TestCheckout stand-in that records what was asked of it. */
class FakeCheckout {
  resets = 0;
  applied: string[] = [];
  rejectDiffs = new Set<string>();
  testExitCode = 0;
  reset(): Promise<void> {
    this.resets += 1;
    this.applied = [];
    return Promise.resolve();
  }
  apply(diff: string): Promise<ApplyResult> {
    if (this.rejectDiffs.has(diff))
      return Promise.resolve({ applied: false, error: "patch does not apply" });
    this.applied.push(diff);
    return Promise.resolve({ applied: true });
  }
  runTests(): Promise<TestRun> {
    return Promise.resolve({
      exitCode: this.testExitCode,
      output: "suite output",
      durationMs: 5,
      timedOut: false,
      buildFailed: false,
    });
  }
}

function call(
  name: string,
  input: Record<string, unknown>,
  id = "tu_1",
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

const TEST_PATCH =
  "diff --git a/test/a.test.ts b/test/a.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/test/a.test.ts\n@@ -0,0 +1 @@\n+test\n";
const FIX_PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n";

let repoRoot: string;

beforeAll(async () => {
  repoRoot = await mkdtemp(path.join(os.tmpdir(), "pr-verify-test-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "a.ts"),
    Array.from({ length: 500 }, (_, i) => `line ${String(i + 1)}`).join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "secret.ts"),
    'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";',
  );
});

function executor(
  mode: "review" | "red-gate" = "review",
  checkout = new FakeCheckout(),
) {
  const budget = new Budget({
    tokens: 1e6,
    minutes: 10,
    toolCalls: 30,
    testRuns: 2,
    patchAttempts: 3,
    findings: 8,
    unverifiedFindings: 3,
  });
  const exec = new ToolExecutor({
    mode,
    repoRoot,
    tracked: new Set(["src/a.ts", "src/secret.ts", "test/a.test.ts"]),
    budget,
    checkout: checkout as unknown as TestCheckout,
    patchLimits: { maxLines: 200, maxFiles: 6 },
    scrubber: new Scrubber([]),
  });
  return { exec, budget, checkout };
}

describe("read_file", () => {
  it("returns numbered lines within the range and caps at the line limit", async () => {
    const { exec } = executor();
    const whole = await exec.execute(call("read_file", { path: "src/a.ts" }));
    const text = whole.block.content as string;
    expect(text.startsWith("1\tline 1\n")).toBe(true);
    expect(text).toContain(
      `${String(READ_FILE_LIMIT_LINES)}\tline ${String(READ_FILE_LIMIT_LINES)}`,
    );
    expect(text).not.toContain(`${String(READ_FILE_LIMIT_LINES + 1)}\tline`);
    expect(text).toMatch(/\[truncated: showing lines 1-400 of 500\]$/);

    const range = await exec.execute(
      call("read_file", { path: "src/a.ts", start_line: 10, end_line: 12 }),
    );
    expect(range.block.content).toBe("10\tline 10\n11\tline 11\n12\tline 12");
    expect(exec.filesRead.has("src/a.ts")).toBe(true);
  });

  it("does not call a read truncated when end_line runs past the end of the file", async () => {
    const { exec } = executor();
    const result = await exec.execute(
      call("read_file", { path: "src/a.ts", start_line: 499, end_line: 600 }),
    );
    expect(result.block.content).toBe("499\tline 499\n500\tline 500");
    expect(exec.trail[0]?.response).toMatchObject({
      lines: 2,
      truncated: false,
    });
  });

  it("refuses paths outside the repository and untracked files", async () => {
    const { exec } = executor();
    for (const p of [
      "../etc/passwd",
      "/etc/passwd",
      "src/../../x",
      "node_modules/left-pad/index.js",
    ]) {
      const result = await exec.execute(call("read_file", { path: p }));
      expect(result.block.is_error, p).toBe(true);
    }
  });

  it("scrubs secrets from what the model sees", async () => {
    const { exec } = executor();
    const result = await exec.execute(
      call("read_file", { path: "src/secret.ts" }),
    );
    expect(result.block.content).toContain("[redacted]");
    expect(result.block.content).not.toContain("sk-ant-");
  });
});

describe("propose_patch and run_tests", () => {
  it("resets, applies bases in order, then the new patch, and hands back an id", async () => {
    const { exec, checkout } = executor();
    const test = await exec.execute(
      call("propose_patch", {
        kind: "test",
        description: "failing test",
        diff: TEST_PATCH,
      }),
    );
    expect(test.block.is_error).toBeUndefined();
    expect(test.block.content).toContain("Patch 1 (test) applied");

    const fix = await exec.execute(
      call("propose_patch", {
        kind: "fix",
        description: "fix",
        diff: FIX_PATCH,
        base_on: [1],
      }),
    );
    expect(fix.block.content).toContain("Patch 2 (fix) applied");
    expect(checkout.resets).toBe(2);
    expect(checkout.applied).toEqual([
      recountHunks(TEST_PATCH),
      recountHunks(FIX_PATCH),
    ]);
    expect(exec.patches.map((p) => [p.id, p.kind])).toEqual([
      [1, "test"],
      [2, "fix"],
    ]);
  });

  it("rejects a patch the policy forbids before touching the checkout", async () => {
    const { exec, checkout } = executor();
    const result = await exec.execute(
      call("propose_patch", {
        kind: "test",
        description: "x",
        diff: FIX_PATCH,
      }),
    );
    expect(result.block.is_error).toBe(true);
    expect(result.block.content).toContain(
      "a test patch may only touch test locations",
    );
    expect(checkout.resets).toBe(0);
    expect(exec.patches).toEqual([]);
    expect(exec.trail[0]?.response).toMatchObject({
      applied: false,
      diffPreview: FIX_PATCH,
    });
  });

  it("reports a patch that does not apply and does not keep it", async () => {
    const checkout = new FakeCheckout();
    checkout.rejectDiffs.add(FIX_PATCH);
    const { exec } = executor("review", checkout);
    const result = await exec.execute(
      call("propose_patch", { kind: "fix", description: "x", diff: FIX_PATCH }),
    );
    expect(result.block.is_error).toBe(true);
    expect(result.block.content).toContain("did not apply cleanly");
    expect(exec.patches).toEqual([]);
  });

  it("applies the recounted form of a patch whose hunk counts are wrong", async () => {
    const { exec, checkout } = executor();
    const miscounted = TEST_PATCH.replace("@@ -0,0 +1 @@", "@@ -0,0 +1,9 @@");
    const result = await exec.execute(
      call("propose_patch", {
        kind: "test",
        description: "t",
        diff: miscounted,
      }),
    );
    expect(result.block.is_error).toBeUndefined();
    expect(checkout.applied[0]).toContain("@@ -0,0 +1,1 @@");
    expect(exec.patches[0]?.diff).toBe(checkout.applied[0]);
  });

  it("explains a rejected hunk that has context before its change and none after", async () => {
    const checkout = new FakeCheckout();
    const noTrailing =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5,2 +5,3 @@\n line 5\n line 6\n+added\n";
    checkout.rejectDiffs.add(recountHunks(noTrailing));
    const { exec } = executor("review", checkout);
    const result = await exec.execute(
      call("propose_patch", {
        kind: "fix",
        description: "x",
        diff: noTrailing,
      }),
    );
    expect(result.block.is_error).toBe(true);
    expect(result.block.content).toContain(
      "src/a.ts: the hunk at old line 5 has 2 context line(s) before its change and none after",
    );
    expect(exec.trail[0]?.response).toMatchObject({
      applied: false,
      diffPreview: noTrailing,
    });
  });

  it("charges the test-run budget and returns the exit code", async () => {
    const checkout = new FakeCheckout();
    checkout.testExitCode = 1;
    const { exec, budget } = executor("review", checkout);
    const result = await exec.execute(call("run_tests", {}));
    expect(result.block.content).toContain("Test run exit code 1.");
    expect(budget.usage().testRuns).toBe(1);
    await exec.execute(call("run_tests", {}));
    await expect(exec.execute(call("run_tests", {}))).rejects.toThrow(
      "budget exceeded: testRuns",
    );
  });

  it("records a trail entry per call with patch file summaries", async () => {
    const { exec } = executor();
    await exec.execute(
      call("propose_patch", {
        kind: "test",
        description: "failing test",
        diff: TEST_PATCH,
      }),
    );
    expect(exec.trail).toHaveLength(1);
    expect(exec.trail[0]).toMatchObject({
      n: 1,
      tool: "propose_patch",
      request: {
        kind: "test",
        files: [{ path: "test/a.test.ts", added: 1, removed: 0 }],
      },
      response: { applied: true, patchId: 1 },
    });
  });
});

describe("finish", () => {
  it("validates review findings and resolves them against accepted patches", async () => {
    const { exec } = executor();
    await exec.execute(
      call("propose_patch", {
        kind: "test",
        description: "t",
        diff: TEST_PATCH,
      }),
    );
    const result = await exec.execute(
      call("finish", {
        findings: [
          {
            category: "bug",
            confidence: "high",
            file: "src/a.ts",
            line: 3,
            title: "Off by one",
            explanation: "one\ntwo\nthree\nfour\nfive",
            test_patch: 1,
          },
        ],
      }),
    );
    expect(result.finished).toEqual({
      mode: "review",
      findings: [
        {
          category: "bug",
          confidence: "high",
          file: "src/a.ts",
          line: 3,
          title: "Off by one",
          explanation: "one\ntwo\nthree\nfour",
          testPatch: 1,
        },
      ],
    });
  });

  it("rejects a finding that cites a patch of the wrong kind, a missing patch, or an untracked file", async () => {
    const { exec } = executor();
    await exec.execute(
      call("propose_patch", {
        kind: "test",
        description: "t",
        diff: TEST_PATCH,
      }),
    );
    const base = {
      category: "bug",
      confidence: "high",
      file: "src/a.ts",
      line: 3,
      title: "t",
      explanation: "e",
    };

    const wrongKind = await exec.execute(
      call("finish", { findings: [{ ...base, fix_patch: 1, test_patch: 1 }] }),
    );
    expect(wrongKind.finished).toBeNull();
    expect(wrongKind.block.content).toContain(
      "patch 1 is a test patch, not a fix patch",
    );

    const missing = await exec.execute(
      call("finish", { findings: [{ ...base, test_patch: 9 }] }),
    );
    expect(missing.block.content).toContain("patch 9 does not exist");

    const untracked = await exec.execute(
      call("finish", { findings: [{ ...base, file: "src/nope.ts" }] }),
    );
    expect(untracked.block.content).toContain("not a tracked file");
  });

  it("requires a fix verdict to name its patch in red-gate mode", async () => {
    const { exec } = executor("red-gate");
    const noPatch = await exec.execute(
      call("finish", { verdict: "fix", summary: "s", citations: [] }),
    );
    expect(noPatch.block.is_error).toBe(true);

    await exec.execute(
      call("propose_patch", { kind: "fix", description: "f", diff: FIX_PATCH }),
    );
    const ok = await exec.execute(
      call("finish", {
        verdict: "fix",
        summary: "a\nb\nc\nd",
        citations: ["src/a.ts:1"],
        fix_patch: 1,
      }),
    );
    expect(ok.finished).toEqual({
      mode: "red-gate",
      result: {
        verdict: "fix",
        summary: "a\nb\nc",
        citations: ["src/a.ts:1"],
        fixPatch: 1,
      },
    });
  });
});
