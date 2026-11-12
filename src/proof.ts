/**
 * The only path to "verified". Each proof turns a patch into a verdict by
 * running it on the test checkout from a clean reset: a test that fails and a
 * fix that makes it pass, an earlier finding's test re-run on a new push, a
 * red-gate fix, or a fix that clears what Semgrep found.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BYTES_PER_KB } from "./budget.js";
import { git } from "./claude-context.js";
import { checkPatchPolicy, type PatchLimits } from "./patch-policy.js";
import { runCommand, type TestCheckout } from "./test-checkout.js";
import type { Patch } from "./types.js";

/** Only the end of Semgrep's console output is kept, to show when Semgrep itself fails. */
const SEMGREP_OUTPUT_LIMIT_KB = 16;
const SEMGREP_OUTPUT_LIMIT_BYTES = SEMGREP_OUTPUT_LIMIT_KB * BYTES_PER_KB;

export interface Verification {
  /** True when the test patch alone makes the suite fail on the PR commit. Null when no test patch. */
  testFails: boolean | null;
  /** True when test plus fix make the suite pass. Null when no fix patch or the test did not fail. */
  fixPasses: boolean | null;
  runs: number;
  durationMs: number;
}

/**
 * Re-runs the agent's demonstration from a clean checkout. Only these runs count.
 * A fix is only tried once its test has been shown to fail; a fix for a test
 * that already passes proves nothing.
 */
export async function verifyDemonstration(
  checkout: TestCheckout,
  testPatch: Patch | undefined,
  fixPatch: Patch | undefined,
): Promise<Verification> {
  const startedAt = Date.now();
  let runs = 0;
  let testFails: boolean | null = null;
  let fixPasses: boolean | null = null;

  if (testPatch) {
    await checkout.reset();
    const applied = await checkout.apply(testPatch.diff);
    if (applied.applied) {
      runs += 1;
      const result = await checkout.runTests();
      // A test that breaks the build demonstrates nothing about the code under test.
      testFails = result.exitCode !== 0 && !result.buildFailed;
    } else {
      testFails = false;
    }
  }

  if (fixPatch && testFails === true && testPatch) {
    await checkout.reset();
    const testApplied = await checkout.apply(testPatch.diff);
    const fixApplied = testApplied.applied
      ? await checkout.apply(fixPatch.diff)
      : testApplied;
    if (fixApplied.applied) {
      runs += 1;
      const result = await checkout.runTests();
      fixPasses = result.exitCode === 0;
    } else {
      fixPasses = false;
    }
  }

  await checkout.reset();
  return { testFails, fixPasses, runs, durationMs: Date.now() - startedAt };
}

/** The gate's Semgrep run, which the harness repeats to verify a fix: the pinned image and the gate's arguments. */
export interface StaticAnalysis {
  image: string;
  args: string;
}

export interface StaticAnalysisResult {
  /** Null when Semgrep itself failed, so the run says nothing about the code. */
  findings: number | null;
  output: string;
  durationMs: number;
}

/**
 * Runs Semgrep over the checkout as the gate ran it and counts the findings. It
 * runs outside the sandbox, in its own container with only the checkout mounted,
 * since it reads the project's code and never executes it.
 */
export async function runStaticAnalysis(
  checkout: TestCheckout,
  analysis: StaticAnalysis,
  timeoutMs: number,
): Promise<StaticAnalysisResult> {
  // Semgrep scans only what git tracks, and files a patch added are untracked.
  await git(["add", "--intent-to-add", "."], checkout.root);
  const out = await mkdtemp(path.join(os.tmpdir(), "pr-verify-semgrep-"));
  try {
    const command = [
      "docker run --rm",
      `--user ${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      `-e HOME=/tmp -v "${checkout.root}:/src" -v "${out}:/out" -w /src`,
      analysis.image,
      "semgrep scan",
      analysis.args,
      "--metrics off --disable-version-check --json --output /out/results.json",
    ].join(" ");
    const result = await runCommand(
      command,
      checkout.root,
      timeoutMs,
      SEMGREP_OUTPUT_LIMIT_BYTES,
    );
    if (result.exitCode !== 0)
      return {
        findings: null,
        output: result.output,
        durationMs: result.durationMs,
      };
    const report = JSON.parse(
      await readFile(path.join(out, "results.json"), "utf8"),
    ) as { results?: unknown[] };
    return {
      findings: report.results?.length ?? 0,
      output: result.output,
      durationMs: result.durationMs,
    };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/**
 * Red-gate mode at the static analysis step: a fix is verified when Semgrep
 * finds nothing with only the fix applied and the suite still passes.
 * `countFindings` runs Semgrep on the checkout as it stands.
 */
export async function verifyStaticAnalysisFix(
  checkout: TestCheckout,
  fixPatch: Patch,
  countFindings: () => Promise<number | null>,
): Promise<Verification & { findingsLeft: number | null }> {
  const startedAt = Date.now();
  await checkout.reset();
  let findingsLeft: number | null = null;
  let fixPasses = false;
  let runs = 0;
  if ((await checkout.apply(fixPatch.diff)).applied) {
    findingsLeft = await countFindings();
    if (findingsLeft === 0) {
      runs = 1;
      fixPasses = (await checkout.runTests()).exitCode === 0;
    }
  }
  await checkout.reset();
  return {
    testFails: null,
    fixPasses,
    runs,
    findingsLeft,
    durationMs: Date.now() - startedAt,
  };
}

/** passes: the bug is gone. fails: still there. unusable: the test does not fit this commit, so it says nothing. */
export type RecheckResult = "passes" | "fails" | "unusable";

/**
 * Runs an earlier finding's test against the current PR commit. The test is
 * applied, or used as it stands when the author has already committed it.
 * It goes through the same policy as a fresh test patch first, because it was
 * read back from a comment.
 */
export async function recheckDemonstration(
  checkout: TestCheckout,
  testDiff: string,
  limits: PatchLimits,
): Promise<{ result: RecheckResult; runs: number; durationMs: number }> {
  const startedAt = Date.now();
  if (!checkPatchPolicy(testDiff, "test", limits).ok)
    return { result: "unusable", runs: 0, durationMs: 0 };

  await checkout.reset();
  let result: RecheckResult = "unusable";
  let runs = 0;
  if (
    (await checkout.apply(testDiff)).applied ||
    (await checkout.contains(testDiff))
  ) {
    runs = 1;
    const run = await checkout.runTests();
    if (!run.buildFailed) result = run.exitCode === 0 ? "passes" : "fails";
  }
  await checkout.reset();
  return { result, runs, durationMs: Date.now() - startedAt };
}

/** Red-gate mode: a fix is verified when the suite that failed now passes with only the fix applied. */
export async function verifyRedGateFix(
  checkout: TestCheckout,
  fixPatch: Patch,
): Promise<Verification> {
  const startedAt = Date.now();
  await checkout.reset();
  const applied = await checkout.apply(fixPatch.diff);
  let fixPasses = false;
  let runs = 0;
  if (applied.applied) {
    runs = 1;
    const result = await checkout.runTests();
    fixPasses = result.exitCode === 0;
  }
  await checkout.reset();
  return {
    testFails: null,
    fixPasses,
    runs,
    durationMs: Date.now() - startedAt,
  };
}
