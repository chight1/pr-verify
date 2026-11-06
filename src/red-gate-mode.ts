/**
 * Red-gate mode, run when the gate fails: label infrastructure, scanner and
 * flaky failures without the model, have the agent diagnose the rest, and show
 * a fix only once the harness has seen it work.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildRedGateBrief, stoppedOutcome } from "./agent.js";
import {
  buildRepositoryMap,
  collectDiff,
  fetchFailingStepLog,
  readGuidance,
  trackedFiles,
  type Guidance,
  type PullRequestDiff,
  type RepositoryMap,
} from "./context.js";
import { tooLargeNote } from "./notes.js";
import { upsertComment } from "./pr-comments.js";
import { preclassify, scanFailure } from "./preclassify.js";
import {
  runStaticAnalysis,
  verifyRedGateFix,
  verifyStaticAnalysisFix,
  type StaticAnalysis,
} from "./proof.js";
import type { ScratchTree } from "./scratch-tree.js";
import {
  createScratchTree,
  RED_GATE_KEY,
  recordContextSizes,
  runStageAgent,
  type AgentRun,
  type Stage,
} from "./stage.js";
import type { Patch, RedGateResult } from "./types.js";

/** The failing gate step, and what its name says about how a fix can be checked. */
interface GateFailure {
  stepName: string;
  /** The step's log, scrubbed. */
  log: string;
  staticAnalysis: StaticAnalysis | null;
  isTestStep: boolean;
  diagnosisOnly: boolean;
}

/** What the agent reads, gathered once the failure needs it. */
interface RedGateContext {
  diff: PullRequestDiff;
  tracked: string[];
  guidance: Guidance | null;
  map: RepositoryMap;
}

/** The agent's verdict once its fix, if any, has been checked. */
interface CheckedVerdict {
  verdict: RedGateResult["verdict"];
  fixPatch: Patch | undefined;
  /** Why a proposed fix is not shown, or empty. */
  note: string;
}

export async function redGateMode(stage: Stage): Promise<void> {
  const { record } = stage;

  if (!stage.inputs.commentOnRedGate) {
    record.outcome = "abstain";
    return;
  }

  const failure = await fetchGateFailure(stage);
  if (!failure) {
    record.outcome = "abstain";
    core.info("Could not find a failing gate step to investigate.");
    return;
  }
  if (await preclassified(stage, failure)) return;

  const tree = await createScratchTree(stage);
  if (failure.isTestStep && (await passesOnRerun(stage, failure, tree))) return;
  const context = await gatherContext(stage);
  if (await declinedAsTooLarge(stage, failure, context.diff)) return;

  const { outcome, executor } = await runRedGateAgent(
    stage,
    failure,
    tree,
    context,
  );
  if (outcome.finished?.mode !== "red-gate") {
    record.outcome = stoppedOutcome(outcome);
    await tree.reset();
    return;
  }

  const { result } = outcome.finished;
  const checked = await checkProposedFix(
    stage,
    failure,
    tree,
    result,
    executor.patches,
  );
  await tree.reset();
  await postVerdict(stage, failure, result, checked);
}

async function fetchGateFailure(stage: Stage): Promise<GateFailure | null> {
  const { inputs, pr, record } = stage;
  const failing = await fetchFailingStepLog(
    stage.octokit,
    pr.owner,
    pr.repo,
    github.context.runId,
    inputs.gateJobName,
  );
  if (!failing) return null;
  const log = stage.scrubber.scrub(failing.log);
  record.contextSizes.failingLogBytes = Buffer.byteLength(log);

  const step = failing.stepName.toLowerCase();
  return {
    stepName: failing.stepName,
    log,
    // With the gate's Semgrep run to repeat, a static analysis failure can get a verified fix like a test failure.
    staticAnalysis: step === "static analysis" ? inputs.staticAnalysis : null,
    isTestStep: step.includes("test"),
    // A green suite says nothing about whether a build, lint or formatting fix works.
    diagnosisOnly:
      step.includes("build") ||
      step.includes("lint") ||
      step === "code quality",
  };
}

/** Posts the note for an infrastructure or scanner failure, which the agent is not run on; true when it did. */
async function preclassified(
  stage: Stage,
  failure: GateFailure,
): Promise<boolean> {
  const { octokit, pr, record } = stage;
  const infra = preclassify(failure.log);
  if (infra) {
    record.preclassification = infra;
    record.outcome = "infra";
    record.postedId = await upsertComment(
      octokit,
      pr,
      RED_GATE_KEY,
      `### PR Verify: gate failed at \`${failure.stepName}\`\n\nThis looks like an infrastructure failure (${infra.label}), not the change:\n\n\`\`\`\n${infra.evidence}\n\`\`\`\n\nRe-run the job. [Run record](${stage.runUrl})`,
    );
    return true;
  }

  const scan = failure.staticAnalysis ? null : scanFailure(failure.stepName);
  if (scan) {
    record.outcome = "scan";
    record.postedId = await upsertComment(
      octokit,
      pr,
      RED_GATE_KEY,
      `### PR Verify: gate failed at \`${failure.stepName}\`\n\n${scan} Not investigated: the agent cannot run the scanner, so it could not verify a fix. [Run record](${stage.runUrl})`,
    );
    return true;
  }
  return false;
}

/** Re-runs the suite unchanged on this commit; when it passes, posts the flaky note. */
async function passesOnRerun(
  stage: Stage,
  failure: GateFailure,
  tree: ScratchTree,
): Promise<boolean> {
  const { record } = stage;
  await tree.reset();
  const rerun = await tree.runTests();
  record.verification.testRuns += 1;
  record.verification.durationMs += rerun.durationMs;
  if (rerun.exitCode !== 0) return false;

  record.outcome = "flaky";
  record.postedId = await upsertComment(
    stage.octokit,
    stage.pr,
    RED_GATE_KEY,
    `### PR Verify: gate failed at \`${failure.stepName}\`\n\nThe suite passed when re-run unchanged on this commit, so the failure looks flaky. Re-run the job, and consider the failing test suspect. [Run record](${stage.runUrl})`,
  );
  return true;
}

async function gatherContext(stage: Stage): Promise<RedGateContext> {
  const { inputs, repoRoot, record } = stage;
  const [diff, tracked, guidance] = await Promise.all([
    collectDiff(stage.pr, repoRoot),
    trackedFiles(repoRoot),
    readGuidance(repoRoot, inputs.guidanceFile),
  ]);
  const map = buildRepositoryMap(tracked);
  recordContextSizes(record, diff, map, guidance);
  return { diff, tracked, guidance, map };
}

/** Posts that the failure was not investigated when the diff is over its share of the budget; true when it did. */
async function declinedAsTooLarge(
  stage: Stage,
  failure: GateFailure,
  diff: PullRequestDiff,
): Promise<boolean> {
  const { record } = stage;
  const tooLarge = tooLargeNote(diff, stage.inputs.limits);
  if (!tooLarge) return false;

  record.outcome = "too-large";
  record.postedId = await upsertComment(
    stage.octokit,
    stage.pr,
    RED_GATE_KEY,
    `### PR Verify: gate failed at \`${failure.stepName}\`\n\nNot investigated. ${tooLarge} The failing step's log is in the run. [Run record](${stage.runUrl})`,
  );
  return true;
}

async function runRedGateAgent(
  stage: Stage,
  failure: GateFailure,
  tree: ScratchTree,
  context: RedGateContext,
): Promise<AgentRun> {
  const brief = buildRedGateBrief({
    diff: context.diff.text,
    omitted: context.diff.omitted,
    guidance: context.guidance?.text ?? null,
    stepName: failure.stepName,
    log: failure.log,
  });
  return runStageAgent(
    stage,
    "red-gate",
    tree,
    context,
    stage.scrubber.scrub(brief),
  );
}

/** The agent's verdict, keeping a proposed fix only where it can be verified and only once it has been. */
async function checkProposedFix(
  stage: Stage,
  failure: GateFailure,
  tree: ScratchTree,
  result: RedGateResult,
  patches: Patch[],
): Promise<CheckedVerdict> {
  const fixPatch =
    result.fixPatch !== undefined
      ? patches.find((p) => p.id === result.fixPatch)
      : undefined;

  if (
    result.verdict === "fix" &&
    failure.diagnosisOnly &&
    !failure.isTestStep
  ) {
    return {
      verdict: "diagnosis",
      fixPatch: undefined,
      note: "A fix was proposed but build and lint failures are diagnosed only, since no green suite can verify them.",
    };
  }
  if (result.verdict === "fix" && fixPatch)
    return verifyFix(stage, failure, tree, fixPatch);
  return { verdict: result.verdict, fixPatch, note: "" };
}

/** Re-runs the proposed fix from a clean tree; a fix that does not verify falls back to the diagnosis. */
async function verifyFix(
  stage: Stage,
  failure: GateFailure,
  tree: ScratchTree,
  fixPatch: Patch,
): Promise<CheckedVerdict> {
  const { inputs, record } = stage;
  const { staticAnalysis } = failure;
  const scanned = staticAnalysis
    ? await verifyStaticAnalysisFix(tree, fixPatch, () =>
        countStaticAnalysisFindings(tree, staticAnalysis, inputs.testTimeoutMs),
      )
    : null;
  const verification = scanned ?? (await verifyRedGateFix(tree, fixPatch));
  record.verification.fixRuns += verification.runs;
  record.verification.durationMs += verification.durationMs;
  if (verification.fixPasses) return { verdict: "fix", fixPatch, note: "" };

  return {
    verdict: "diagnosis",
    fixPatch: undefined,
    note: scanned
      ? staticAnalysisNote(scanned.findingsLeft)
      : "The proposed fix did not make the suite pass when re-run by the harness, so only the diagnosis is shown.",
  };
}

/** Posts the diagnosis, with the fix when it verified, unless the agent abstained. */
async function postVerdict(
  stage: Stage,
  failure: GateFailure,
  result: RedGateResult,
  checked: CheckedVerdict,
): Promise<void> {
  const { record } = stage;
  if (checked.verdict === "abstain") {
    record.outcome = "abstain";
    return;
  }

  const verified = failure.staticAnalysis
    ? "**Verified fix.** Semgrep finds nothing and the suite passes with the patch below applied."
    : "**Verified fix.** The suite passes with the patch below applied.";
  const lines = [
    `### PR Verify: gate failed at \`${failure.stepName}\``,
    "",
    checked.verdict === "fix" ? verified : "**Diagnosis.**",
    "",
    result.summary,
  ];
  if (result.citations.length > 0) {
    lines.push("", "Evidence:", ...result.citations.map((c) => `- ${c}`));
  }
  if (checked.fixPatch) {
    lines.push(
      "",
      `<details><summary>${checked.fixPatch.description}</summary>`,
      "",
      `\`\`\`diff\n${checked.fixPatch.diff.trimEnd()}\n\`\`\``,
      "</details>",
    );
  }
  if (checked.note) lines.push("", `_${checked.note}_`);
  lines.push("", `[Run record](${stage.runUrl})`);

  record.postedId = await upsertComment(
    stage.octokit,
    stage.pr,
    RED_GATE_KEY,
    stage.scrubber.scrub(lines.join("\n")),
  );
  record.outcome = checked.verdict;
}

async function countStaticAnalysisFindings(
  tree: ScratchTree,
  analysis: StaticAnalysis,
  timeoutMs: number,
): Promise<number | null> {
  const result = await runStaticAnalysis(tree, analysis, timeoutMs);
  if (result.findings === null)
    core.warning(`Semgrep failed on the proposed fix:\n${result.output}`);
  return result.findings;
}

/** Why a static analysis fix did not verify, for the comment. */
function staticAnalysisNote(findingsLeft: number | null): string {
  if (findingsLeft === null)
    return "Semgrep could not be re-run with the proposed fix applied, so only the diagnosis is shown.";
  if (findingsLeft > 0) {
    return `Semgrep still reported ${String(findingsLeft)} finding(s) with the proposed fix applied, so only the diagnosis is shown.`;
  }
  return "Semgrep found nothing with the proposed fix applied, but the suite did not pass, so only the diagnosis is shown.";
}
