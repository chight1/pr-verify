/**
 * Review mode, run when the gate passes: check the suite passes in the sandbox
 * on the PR commit as it stands, re-check what earlier runs reported, let the
 * agent look for bugs, and post only what survives verification and the caps.
 */

import path from "node:path";
import * as core from "@actions/core";
import { type AgentOutcome, stoppedOutcome } from "./claude-harness.js";
import { buildReviewBrief } from "./prompts.js";
import {
  buildRepositoryMap,
  byCodeUnits,
  collectDiff,
  readGuidance,
  trackedFiles,
  type Guidance,
  type PullRequestDiff,
  type RepositoryMap,
} from "./claude-context.js";
import { parseDiff, type DiffFile } from "./diff.js";
import { postingLogin, type PostedFinding } from "./comment-markers.js";
import { baselineNote, tooLargeNote } from "./skip-notes.js";
import { isTestPath } from "./patch-policy.js";
import { deleteComment, updateComment, upsertComment } from "./pr-comments.js";
import {
  fetchPriorFindings,
  gitDiffBetween,
  resolvePriorFindings,
  resolveThreads,
  type Resolution,
} from "./prior-findings.js";
import { recheckDemonstration } from "./proof.js";
import type { RunRecord } from "./run-record.js";
import { buildReview, postReview, type ReviewTrail } from "./post-review.js";
import type { TestCheckout } from "./test-checkout.js";
import {
  findingRecord,
  findingRecords,
  verifyAndSelect,
} from "./finding-selection.js";
import {
  BASELINE_KEY,
  createTestCheckout,
  RED_GATE_KEY,
  recordContextSizes,
  runStageAgent,
  TOO_LARGE_KEY,
  type AgentRun,
  type Stage,
} from "./mode-setup.js";
import type { Finding, PriorFinding, ResolvedFinding } from "./types.js";

const TEST_EXAMPLES_SHOWN = 5;
const TEST_DIRS_SHOWN = 8;
const SHORT_SHA_LENGTH = 7;

/** What the review reads, gathered before anything runs. */
interface ReviewContext {
  /** The account this action posts as, so its earlier findings can be found. */
  author: string;
  diff: PullRequestDiff;
  diffFiles: DiffFile[];
  tracked: string[];
  guidance: Guidance | null;
  prior: PostedFinding[];
  map: RepositoryMap;
}

export async function reviewMode(stage: Stage): Promise<void> {
  const { record } = stage;

  await updateRedGateComment(stage);
  const context = await gatherContext(stage);
  if (await declinedAsTooLarge(stage, context.diff)) return;
  if (context.diffFiles.length === 0) {
    await reportEmptyDiff(stage, context.diff);
    return;
  }

  const checkout = await createTestCheckout(stage);
  if (!(await baselinePasses(stage, checkout))) return;
  const resolution = await recheckPriorFindings(stage, checkout, context.prior);
  const agent = await runReviewAgent(stage, checkout, context, resolution.open);
  if (agent.outcome.finished?.mode !== "review") {
    await reportStopped(stage, checkout, agent.outcome);
    return;
  }

  const selection = await verifyAndSelect(
    agent.outcome.finished.findings,
    agent.executor.patches,
    resolution.open,
    checkout,
    stage,
  );
  await checkout.reset();
  record.findings = findingRecords(selection);

  if (selection.kept.length === 0 && resolution.resolved.length === 0) {
    record.outcome = "clean";
    await core.summary.addRaw("PR Verify: nothing to report.").write();
    return;
  }
  await postFindings(
    stage,
    context,
    agent,
    selection.kept,
    resolution.resolved,
  );
}

/** A red-gate comment from an earlier run would still say the gate fails. */
async function updateRedGateComment(stage: Stage): Promise<void> {
  const { pr } = stage;
  await updateComment(
    stage.octokit,
    pr,
    RED_GATE_KEY,
    `### PR Verify: gate passes\n\nThe gate passes on \`${pr.headSha.slice(0, SHORT_SHA_LENGTH)}\`, so the failure this comment reported earlier no longer applies. [Run record](${stage.runUrl})`,
  );
}

async function gatherContext(stage: Stage): Promise<ReviewContext> {
  const { inputs, pr, octokit, repoRoot, record } = stage;
  const author = await postingLogin(octokit);
  const [diff, tracked, guidance, prior] = await Promise.all([
    collectDiff(pr, repoRoot),
    trackedFiles(repoRoot),
    readGuidance(repoRoot, inputs.guidanceFile),
    fetchPriorFindings(octokit, pr, author),
  ]);
  const diffFiles = parseDiff(diff.text);
  const map = buildRepositoryMap(tracked);
  recordContextSizes(record, diff, map, guidance);
  return { author, diff, diffFiles, tracked, guidance, prior, map };
}

/** Posts the too-large note in place of a review when the diff is over its share of the budget; true when it did. */
async function declinedAsTooLarge(
  stage: Stage,
  diff: PullRequestDiff,
): Promise<boolean> {
  const { octokit, pr, record } = stage;
  const tooLarge = tooLargeNote(diff, stage.inputs.limits);
  if (tooLarge) {
    record.outcome = "too-large";
    record.postedId = await upsertComment(
      octokit,
      pr,
      TOO_LARGE_KEY,
      `### PR Verify: not reviewed\n\n${tooLarge} The gate still ran and still decides the merge. [Run record](${stage.runUrl})`,
    );
    return true;
  }
  await deleteComment(octokit, pr, TOO_LARGE_KEY);
  return false;
}

async function reportEmptyDiff(
  stage: Stage,
  diff: PullRequestDiff,
): Promise<void> {
  stage.record.outcome = "clean";
  const why =
    diff.omitted.length > 0
      ? "only machine-written files changed"
      : "empty diff";
  await core.summary.addRaw(`PR Verify: ${why}, nothing to review.`).write();
}

/** Runs the suite on the PR commit as it stands; when it fails, posts the baseline note instead of a review. */
async function baselinePasses(
  stage: Stage,
  checkout: TestCheckout,
): Promise<boolean> {
  const { octokit, pr, record } = stage;
  // A failing test proves a bug only if the suite passes here, in the sandbox, without it.
  await checkout.reset();
  const baseline = await checkout.runTests();
  record.baseline = {
    passed: baseline.exitCode === 0,
    buildFailed: baseline.buildFailed,
    durationMs: baseline.durationMs,
  };
  if (baseline.exitCode !== 0) {
    record.outcome = "baseline";
    record.postedId = await upsertComment(
      octokit,
      pr,
      BASELINE_KEY,
      stage.scrubber.scrub(baselineNote(baseline, stage.runUrl)),
    );
    return false;
  }
  await deleteComment(octokit, pr, BASELINE_KEY);
  return true;
}

/** Re-runs each earlier finding's test on this commit, so the ones this push fixed are marked resolved. */
async function recheckPriorFindings(
  stage: Stage,
  checkout: TestCheckout,
  prior: PostedFinding[],
): Promise<Resolution> {
  const { inputs, record } = stage;
  const recheck = async (testPatch: string) => {
    const { result, runs, durationMs } = await recheckDemonstration(
      checkout,
      testPatch,
      inputs.patchLimits,
    );
    record.verification.recheckRuns += runs;
    record.verification.durationMs += durationMs;
    return result;
  };
  const resolution = await resolvePriorFindings(
    prior,
    stage.pr.headSha,
    recheck,
    gitDiffBetween(stage.repoRoot),
  );
  record.resolvedPriorFindings = resolution.resolved;
  record.contextSizes.priorFindingsBytes = Buffer.byteLength(
    JSON.stringify(resolution.open),
  );
  return resolution;
}

async function runReviewAgent(
  stage: Stage,
  checkout: TestCheckout,
  context: ReviewContext,
  open: PriorFinding[],
): Promise<AgentRun> {
  const brief = buildReviewBrief({
    diff: context.diff.text,
    omitted: context.diff.omitted,
    guidance: context.guidance?.text ?? null,
    openFindings: open,
    testConventions: describeTestConventions(context.tracked),
  });
  return runStageAgent(
    stage,
    "review",
    checkout,
    context,
    stage.scrubber.scrub(brief),
  );
}

function describeTestConventions(files: string[]): string {
  const dirs = new Set<string>();
  const examples: string[] = [];
  for (const file of files) {
    if (!isTestPath(file)) continue;
    const dir = path.posix.dirname(file);
    dirs.add(dir);
    if (examples.length < TEST_EXAMPLES_SHOWN) examples.push(file);
  }
  if (dirs.size === 0) {
    return "No test files were recognised. A test patch may still add files under a test/ or tests/ directory, or files named *.test.* / *_test.* / test_*.";
  }
  const topDirs = [...dirs]
    .sort(byCodeUnits)
    .slice(0, TEST_DIRS_SHOWN)
    .join(", ");
  return `Test files live under: ${topDirs}. Examples: ${examples.join(", ")}. A test patch may add files in these locations or add to these files.`;
}

/** The agent stopped without calling finish, so there is nothing to post. */
async function reportStopped(
  stage: Stage,
  checkout: TestCheckout,
  outcome: AgentOutcome,
): Promise<void> {
  stage.record.outcome = stoppedOutcome(outcome);
  await checkout.reset();
  const reason = outcome.budgetTripped
    ? `budget: ${outcome.budgetTripped}`
    : String(outcome.stopReason);
  await core.summary.addRaw(`PR Verify: no review posted (${reason}).`).write();
}

/** Posts the kept and resolved findings as one review. */
async function postFindings(
  stage: Stage,
  context: ReviewContext,
  agent: AgentRun,
  kept: Finding[],
  resolved: ResolvedFinding[],
): Promise<void> {
  const { octokit, pr, record, scrubber } = stage;
  const trail = reviewTrail(agent, record, stage.runUrl);
  const draft = buildReview(
    kept,
    agent.executor.patches,
    resolved,
    { headSha: pr.headSha, diffFiles: context.diffFiles },
    trail,
  );
  draft.body = scrubber.scrub(draft.body);
  for (const comment of draft.comments)
    comment.body = scrubber.scrub(comment.body);

  record.postedId = await postReview(octokit, pr, draft);
  // The review is posted either way; a thread left open is only untidy.
  await resolveThreads(octokit, pr, context.author, resolved).catch(
    (error: unknown) => {
      core.warning(`Could not resolve review threads: ${String(error)}`);
    },
  );
  // Placement is decided by buildReview, so refresh the kept entries now that it has run.
  record.findings = [
    ...kept.map((f, i) => findingRecord(f, i + 1)),
    ...record.findings.slice(kept.length),
  ];
  record.outcome = "findings";
  await core.summary
    .addRaw(
      `PR Verify: posted ${String(kept.length)} finding(s), ${String(resolved.length)} resolved.`,
    )
    .write();
}

/** What the review's footer reports about how it was reached. */
function reviewTrail(
  agent: AgentRun,
  record: RunRecord,
  runUrl: string,
): ReviewTrail {
  const { executor } = agent;
  return {
    filesRead: [...executor.filesRead].sort(byCodeUnits),
    tests: executor.trail
      .filter((t) => t.tool === "run_tests")
      .map((t) => ({
        description: `run ${String(t.n)}`,
        exitCode: (t.response.exitCode as number | null) ?? null,
      })),
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cachedInputTokens: record.usage.cachedInputTokens,
    wallMs: agent.budget.elapsedMs(),
    runUrl,
  };
}
