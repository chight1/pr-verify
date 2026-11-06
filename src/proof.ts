/**
 * The only path to "verified". Each proof turns a patch into a verdict by
 * running it on the scratch tree from a clean reset: a test that fails and a
 * fix that makes it pass, an earlier finding's test re-run on a new push, a
 * red-gate fix, or a fix that clears what Semgrep found.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "./context.js";
import { checkPatchPolicy, type PatchLimits } from "./patch-policy.js";
import { runCommand, type ScratchTree } from "./scratch-tree.js";
import type { Patch } from "./types.js";

const SEMGREP_OUTPUT_TAIL_BYTES = 16 * 1024;

export interface Verification {
  /** True when the test patch alone makes the suite fail on the PR commit. Null when no test patch. */
  testFails: boolean | null;
  /** True when test plus fix make the suite pass. Null when no fix patch or the test did not fail. */
  fixPasses: boolean | null;
  runs: number;
  durationMs: number;
}

/**
 * Re-runs the agent's demonstration from a clean tree. Only these runs count.
 * A fix is only tried once its test has been shown to fail; a fix for a test
 * that already passes proves nothing.
 */
export async function verifyDemonstration(
  tree: ScratchTree,
  testPatch: Patch | undefined,
  fixPatch: Patch | undefined,
): Promise<Verification> {
  const startedAt = Date.now();
  let runs = 0;
  let testFails: boolean | null = null;
  let fixPasses: boolean | null = null;

  if (testPatch) {
    await tree.reset();
    const applied = await tree.apply(testPatch.diff);
    if (applied.applied) {
      runs += 1;
      const result = await tree.runTests();
      // A test that breaks the build demonstrates nothing about the code under test.
      testFails = result.exitCode !== 0 && !result.buildFailed;
    } else {
      testFails = false;
    }
  }

  if (fixPatch && testFails === true && testPatch) {
    await tree.reset();
    const testApplied = await tree.apply(testPatch.diff);
    const fixApplied = testApplied.applied
      ? await tree.apply(fixPatch.diff)
      : testApplied;
    if (fixApplied.applied) {
      runs += 1;
      const result = await tree.runTests();
      fixPasses = result.exitCode === 0;
    } else {
      fixPasses = false;
    }
  }

  await tree.reset();
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
 * Runs Semgrep over the tree as the gate ran it and counts the findings. It
 * runs outside the sandbox, in its own container with only the tree mounted,
 * since it reads the project's code and never executes it.
 */
export async function runStaticAnalysis(
  tree: ScratchTree,
  analysis: StaticAnalysis,
  timeoutMs: number,
): Promise<StaticAnalysisResult> {
  // Semgrep scans only what git tracks, and files a patch added are untracked.
  await git(["add", "--intent-to-add", "."], tree.root);
  const out = await mkdtemp(path.join(os.tmpdir(), "pr-verify-semgrep-"));
  try {
    const command = [
      "docker run --rm",
      `--user ${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      `-e HOME=/tmp -v "${tree.root}:/src" -v "${out}:/out" -w /src`,
      analysis.image,
      "semgrep scan",
      analysis.args,
      "--metrics off --disable-version-check --json --output /out/results.json",
    ].join(" ");
    const result = await runCommand(
      command,
      tree.root,
      timeoutMs,
      SEMGREP_OUTPUT_TAIL_BYTES,
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
 * `countFindings` runs Semgrep on the tree as it stands.
 */
export async function verifyStaticAnalysisFix(
  tree: ScratchTree,
  fixPatch: Patch,
  countFindings: () => Promise<number | null>,
): Promise<Verification & { findingsLeft: number | null }> {
  const startedAt = Date.now();
  await tree.reset();
  let findingsLeft: number | null = null;
  let fixPasses = false;
  let runs = 0;
  if ((await tree.apply(fixPatch.diff)).applied) {
    findingsLeft = await countFindings();
    if (findingsLeft === 0) {
      runs = 1;
      fixPasses = (await tree.runTests()).exitCode === 0;
    }
  }
  await tree.reset();
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
  tree: ScratchTree,
  testDiff: string,
  limits: PatchLimits,
): Promise<{ result: RecheckResult; runs: number; durationMs: number }> {
  const startedAt = Date.now();
  if (!checkPatchPolicy(testDiff, "test", limits).ok)
    return { result: "unusable", runs: 0, durationMs: 0 };

  await tree.reset();
  let result: RecheckResult = "unusable";
  let runs = 0;
  if ((await tree.apply(testDiff)).applied || (await tree.contains(testDiff))) {
    runs = 1;
    const run = await tree.runTests();
    if (!run.buildFailed) result = run.exitCode === 0 ? "passes" : "fails";
  }
  await tree.reset();
  return { result, runs, durationMs: Date.now() - startedAt };
}

/** Red-gate mode: a fix is verified when the suite that failed now passes with only the fix applied. */
export async function verifyRedGateFix(
  tree: ScratchTree,
  fixPatch: Patch,
): Promise<Verification> {
  const startedAt = Date.now();
  await tree.reset();
  const applied = await tree.apply(fixPatch.diff);
  let fixPasses = false;
  let runs = 0;
  if (applied.applied) {
    runs = 1;
    const result = await tree.runTests();
    fixPasses = result.exitCode === 0;
  }
  await tree.reset();
  return {
    testFails: null,
    fixPasses,
    runs,
    durationMs: Date.now() - startedAt,
  };
}
