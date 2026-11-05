/**
 * Entry point. Reads inputs, picks the mode from the gate result, runs the
 * stages in order, and always writes the run record, even on an internal
 * error. Nothing here talks to the model directly; that is agent.ts.
 */

import path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildRedGateBrief,
  buildReviewBrief,
  createClient,
  DEFAULT_MODEL,
  runAgent,
  type AgentOutcome,
  stoppedOutcome,
} from "./agent.js";
import {
  Budget,
  diffTokenLimit,
  estimateTokens,
  type BudgetLimits,
} from "./budget.js";
import {
  buildRepositoryMap,
  collectDiff,
  fetchFailingStepLog,
  readGuidance,
  Scrubber,
  trackedFiles,
  type Octokit,
  type PullRequestDiff,
} from "./context.js";
import { parseDiff } from "./diff.js";
import { preclassify, scanFailure } from "./preclassify.js";
import {
  emptyRecord,
  writeRecord,
  type FindingRecord,
  type RunRecord,
} from "./record.js";
import {
  buildReview,
  deleteComment,
  fetchPriorFindings,
  gitDiffBetween,
  isDuplicate,
  postingLogin,
  postReview,
  resolvePriorFindings,
  updateComment,
  upsertComment,
  type ReviewTrail,
} from "./review.js";
import { Sandbox } from "./sandbox.js";
import { ToolExecutor } from "./tools.js";
import type {
  Finding,
  GateResult,
  Mode,
  Outcome,
  Patch,
  PriorFinding,
  ProposedFinding,
  PullRequestRef,
} from "./types.js";
import {
  isTestPath,
  recheckDemonstration,
  runStaticAnalysis,
  ScratchTree,
  verifyDemonstration,
  verifyRedGateFix,
  verifyStaticAnalysisFix,
  type PatchLimits,
  type StaticAnalysis,
  type TestRun,
} from "./verify.js";

interface Inputs {
  gateResult: GateResult;
  gateJobName: string;
  buildCommand: string;
  testCommand: string;
  anthropicApiKey: string;
  githubToken: string;
  model: string;
  guidanceFile: string;
  commentOnRedGate: boolean;
  limits: BudgetLimits;
  patchLimits: PatchLimits;
  testTimeoutMs: number;
  /** The gate's Semgrep run, when the workflow passes it, so a static analysis fix can be verified. */
  staticAnalysis: StaticAnalysis | null;
}

const GATE_RESULTS = new Set<GateResult>([
  "success",
  "failure",
  "cancelled",
  "skipped",
]);

function integerInput(name: string): number {
  const raw = core.getInput(name, { required: true });
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(
      `input "${name}" must be a non-negative integer, got "${raw}"`,
    );
  return value;
}

function readInputs(): Inputs {
  const gateResult = core.getInput("gate-result", {
    required: true,
  }) as GateResult;
  if (!GATE_RESULTS.has(gateResult))
    throw new Error(
      `input "gate-result" must be one of ${[...GATE_RESULTS].join(", ")}`,
    );
  const anthropicApiKey = core.getInput("anthropic-api-key", {
    required: true,
  });
  core.setSecret(anthropicApiKey);
  const semgrepImage = core.getInput("semgrep-image");
  return {
    gateResult,
    gateJobName: core.getInput("gate-job-name") || "gate",
    buildCommand: core.getInput("build-command", { required: true }),
    testCommand: core.getInput("test-command", { required: true }),
    anthropicApiKey,
    githubToken: core.getInput("github-token", { required: true }),
    model: core.getInput("model") || DEFAULT_MODEL,
    guidanceFile: core.getInput("guidance-file") || "REVIEW.md",
    commentOnRedGate: core.getBooleanInput("comment-on-red-gate"),
    limits: {
      tokens: integerInput("max-tokens"),
      minutes: integerInput("max-minutes"),
      toolCalls: integerInput("max-tool-calls"),
      testRuns: integerInput("max-test-runs"),
      patchAttempts: integerInput("max-patch-attempts"),
      findings: integerInput("max-findings"),
      unverifiedFindings: integerInput("max-unverified-findings"),
    },
    patchLimits: {
      maxLines: integerInput("max-patch-lines"),
      maxFiles: integerInput("max-patch-files"),
    },
    testTimeoutMs: integerInput("test-timeout-minutes") * 60_000,
    staticAnalysis: semgrepImage
      ? { image: semgrepImage, args: core.getInput("semgrep-args") }
      : null,
  };
}

/** The fields of the pull_request event payload this action reads. */
interface PullRequestPayload {
  number: number;
  base?: { sha?: string };
  head?: { sha?: string };
}

function pullRequestFromEvent(): PullRequestRef {
  const pr = github.context.payload.pull_request as
    PullRequestPayload | undefined;
  if (!pr) throw new Error("this action only runs on pull_request events");
  return {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    number: pr.number,
    baseSha: pr.base?.sha ?? "",
    headSha: pr.head?.sha ?? "",
  };
}

function describeTestConventions(files: string[]): string {
  const dirs = new Set<string>();
  const examples: string[] = [];
  for (const file of files) {
    if (!isTestPath(file)) continue;
    const dir = path.posix.dirname(file);
    dirs.add(dir);
    if (examples.length < 5) examples.push(file);
  }
  if (dirs.size === 0) {
    return "No test files were recognised. A test patch may still add files under a test/ or tests/ directory, or files named *.test.* / *_test.* / test_*.";
  }
  const topDirs = [...dirs].sort().slice(0, 8).join(", ");
  return `Test files live under: ${topDirs}. Examples: ${examples.join(", ")}. A test patch may add files in these locations or add to these files.`;
}

const TOO_LARGE_KEY = "too-large";
const RED_GATE_KEY = "red-gate";
const BASELINE_KEY = "baseline";

/**
 * The note posted instead of a review when the diff alone would take more
 * than its share of the token budget, or null when it fits. Like a reviewer
 * who asks for smaller pull requests, this declines rather than fails: the
 * review never blocks a merge, and the gate still decides it.
 */
function tooLargeNote(
  diff: PullRequestDiff,
  limits: BudgetLimits,
): string | null {
  const tokens = estimateTokens(diff.text);
  const limit = diffTokenLimit(limits);
  if (tokens <= limit) return null;
  const kb = Math.round(Buffer.byteLength(diff.text, "utf8") / 1024);
  return (
    `This diff is about ${String(kb)} KB (≈ ${tokens.toLocaleString("en-US")} tokens), over this project's review limit of ` +
    `${limit.toLocaleString("en-US")} tokens, a quarter of its \`max-tokens\` budget. Split it into smaller pull requests to get a review.`
  );
}

interface Stage {
  inputs: Inputs;
  pr: PullRequestRef;
  octokit: Octokit;
  repoRoot: string;
  record: RunRecord;
  scrubber: Scrubber;
  runUrl: string;
}

/** The note posted instead of a review when the unchanged PR commit does not pass in the sandbox. */
function baselineNote(run: TestRun, runUrl: string): string {
  const what = run.timedOut
    ? "The suite timed out"
    : run.buildFailed
      ? "The build failed"
      : "The suite failed";
  return [
    "### PR Verify: not reviewed",
    "",
    `${what} on this commit in the review's sandbox, which has no network and only toolchain variables, so no finding could be verified. The gate runs the suite outside the sandbox and still decides the merge.`,
    "",
    "```",
    run.output.slice(-3000).trimEnd(),
    "```",
    "",
    `[Run record](${runUrl})`,
  ].join("\n");
}

async function reviewMode(stage: Stage): Promise<void> {
  const { inputs, pr, octokit, repoRoot, record, scrubber } = stage;

  // A red-gate comment from an earlier run would still say the gate fails.
  await updateComment(
    octokit,
    pr,
    RED_GATE_KEY,
    `### PR Verify: gate passes\n\nThe gate passes on \`${pr.headSha.slice(0, 7)}\`, so the failure this comment reported earlier no longer applies. [Run record](${stage.runUrl})`,
  );

  const [diff, tracked, guidance, prior] = await Promise.all([
    collectDiff(pr, repoRoot),
    trackedFiles(repoRoot),
    readGuidance(repoRoot, inputs.guidanceFile),
    postingLogin(octokit).then((author) =>
      fetchPriorFindings(octokit, pr, author),
    ),
  ]);
  const diffFiles = parseDiff(diff.text);
  const map = buildRepositoryMap(tracked);
  record.contextSizes.diffBytes = Buffer.byteLength(diff.text);
  record.contextSizes.repositoryMapBytes = Buffer.byteLength(map.text);
  record.contextSizes.guidanceBytes = guidance?.bytes ?? 0;

  const tooLarge = tooLargeNote(diff, inputs.limits);
  if (tooLarge) {
    record.outcome = "too-large";
    record.postedId = await upsertComment(
      octokit,
      pr,
      TOO_LARGE_KEY,
      `### PR Verify: not reviewed\n\n${tooLarge} The gate still ran and still decides the merge. [Run record](${stage.runUrl})`,
    );
    return;
  }
  await deleteComment(octokit, pr, TOO_LARGE_KEY);

  if (diffFiles.length === 0) {
    record.outcome = "clean";
    const why =
      diff.omitted.length > 0
        ? "only machine-written files changed"
        : "empty diff";
    await core.summary.addRaw(`PR Verify: ${why}, nothing to review.`).write();
    return;
  }

  const tree = new ScratchTree(
    repoRoot,
    pr.headSha,
    { build: inputs.buildCommand, test: inputs.testCommand },
    inputs.testTimeoutMs,
    await Sandbox.forRunner(),
  );

  // A failing test proves a bug only if the suite passes here, in the sandbox, without it.
  await tree.reset();
  const baseline = await tree.runTests();
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
      scrubber.scrub(baselineNote(baseline, stage.runUrl)),
    );
    return;
  }
  await deleteComment(octokit, pr, BASELINE_KEY);

  const recheck = async (testPatch: string) => {
    const { result, runs, durationMs } = await recheckDemonstration(
      tree,
      testPatch,
      inputs.patchLimits,
    );
    record.verification.recheckRuns += runs;
    record.verification.durationMs += durationMs;
    return result;
  };
  const resolution = await resolvePriorFindings(
    prior,
    pr.headSha,
    recheck,
    gitDiffBetween(repoRoot),
  );
  record.resolvedPriorFindings = resolution.resolved;
  record.contextSizes.priorFindingsBytes = Buffer.byteLength(
    JSON.stringify(resolution.open),
  );

  const budget = new Budget(inputs.limits);
  const executor = new ToolExecutor({
    mode: "review",
    repoRoot,
    tracked: new Set(tracked),
    budget,
    tree,
    patchLimits: inputs.patchLimits,
    scrubber,
  });

  const outcome = await runAgent({
    client: createClient(inputs.anthropicApiKey),
    model: inputs.model,
    mode: "review",
    repositoryMap: map.text,
    brief: scrubber.scrub(
      buildReviewBrief({
        diff: diff.text,
        omitted: diff.omitted,
        guidance: guidance?.text ?? null,
        openFindings: resolution.open,
        testConventions: describeTestConventions(tracked),
      }),
    ),
    executor,
    budget,
  });
  recordAgentRun(record, executor, budget, outcome);

  if (outcome.finished?.mode !== "review") {
    record.outcome = stoppedOutcome(outcome);
    await tree.reset();
    await core.summary
      .addRaw(
        `PR Verify: no review posted (${outcome.budgetTripped ? `budget: ${outcome.budgetTripped}` : String(outcome.stopReason)}).`,
      )
      .write();
    return;
  }

  const { kept, dropped } = await verifyAndSelect(
    outcome.finished.findings,
    executor.patches,
    resolution.open,
    tree,
    inputs,
    record,
  );
  await tree.reset();

  record.findings = [
    ...kept.map((f, i) => findingRecord(f, i + 1)),
    ...dropped.map((d, i) => ({
      ...findingRecord(d.finding, kept.length + i + 1),
      placement: "dropped" as const,
      dropReason: d.reason,
    })),
  ];

  if (kept.length === 0 && resolution.resolved.length === 0) {
    record.outcome = "clean";
    await core.summary.addRaw("PR Verify: nothing to report.").write();
    return;
  }

  const trail: ReviewTrail = {
    filesRead: [...executor.filesRead].sort(),
    tests: executor.trail
      .filter((t) => t.tool === "run_tests")
      .map((t) => ({
        description: `run ${String(t.n)}`,
        exitCode: (t.response.exitCode as number | null) ?? null,
      })),
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cachedInputTokens: record.usage.cachedInputTokens,
    wallMs: budget.elapsedMs(),
    runUrl: stage.runUrl,
  };
  const draft = buildReview(
    kept,
    executor.patches,
    resolution.resolved,
    diffFiles,
    pr.headSha,
    trail,
  );
  draft.body = scrubber.scrub(draft.body);
  for (const comment of draft.comments)
    comment.body = scrubber.scrub(comment.body);

  record.postedId = await postReview(octokit, pr, draft);
  // Placement is decided by buildReview, so refresh the kept entries now that it has run.
  record.findings = [
    ...kept.map((f, i) => findingRecord(f, i + 1)),
    ...record.findings.slice(kept.length),
  ];
  record.outcome = "findings";
  await core.summary
    .addRaw(
      `PR Verify: posted ${String(kept.length)} finding(s), ${String(resolution.resolved.length)} resolved.`,
    )
    .write();
}

interface Selection {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

/**
 * Turns the agent's proposals into postable findings: verify each
 * demonstration from a clean tree, drop duplicates and weak unverified
 * claims, then apply the caps with verified findings first.
 */
async function verifyAndSelect(
  proposed: ProposedFinding[],
  patches: Patch[],
  open: PriorFinding[],
  tree: ScratchTree,
  inputs: Inputs,
  record: RunRecord,
): Promise<Selection> {
  const verified: Finding[] = [];
  const unverified: Finding[] = [];
  const dropped: Selection["dropped"] = [];

  for (const p of proposed) {
    const testPatch =
      p.testPatch !== undefined
        ? patches.find((x) => x.id === p.testPatch)
        : undefined;
    const fixPatch =
      p.fixPatch !== undefined
        ? patches.find((x) => x.id === p.fixPatch)
        : undefined;
    const finding: Finding = {
      ...p,
      verified: false,
      testPatchVerified: null,
      fixPatchVerified: null,
      placement: "body",
    };

    if (testPatch) {
      const result = await verifyDemonstration(tree, testPatch, fixPatch);
      record.verification.testRuns += 1;
      record.verification.fixRuns += result.fixPasses === null ? 0 : 1;
      record.verification.durationMs += result.durationMs;
      finding.testPatchVerified = result.testFails;
      finding.fixPatchVerified = result.fixPasses;
      finding.verified = result.testFails === true;
      if (!finding.verified) delete finding.testPatch;
      if (finding.fixPatchVerified !== true) delete finding.fixPatch;
    }

    if (isDuplicate(finding, open)) {
      dropped.push({
        finding,
        reason: "already reported on this pull request",
      });
      continue;
    }
    if (finding.verified) {
      verified.push(finding);
    } else if (finding.confidence === "low") {
      dropped.push({ finding, reason: "unverified at low confidence" });
    } else {
      unverified.push(finding);
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  unverified.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  const kept: Finding[] = [];
  for (const f of verified) {
    if (kept.length < inputs.limits.findings) kept.push(f);
    else dropped.push({ finding: f, reason: "over the findings cap" });
  }
  let unverifiedKept = 0;
  for (const f of unverified) {
    if (
      kept.length < inputs.limits.findings &&
      unverifiedKept < inputs.limits.unverifiedFindings
    ) {
      kept.push(f);
      unverifiedKept += 1;
    } else {
      dropped.push({ finding: f, reason: "over the unverified cap" });
    }
  }
  return { kept, dropped };
}

function findingRecord(f: Finding, n: number): FindingRecord {
  return {
    n,
    category: f.category,
    verified: f.verified,
    confidence: f.confidence,
    file: f.file,
    line: f.line,
    title: f.title,
    testPatchVerified: f.testPatchVerified,
    fixPatchVerified: f.fixPatchVerified,
    placement: f.placement,
  };
}

function recordAgentRun(
  record: RunRecord,
  executor: ToolExecutor,
  budget: Budget,
  outcome: AgentOutcome,
): void {
  const usage = budget.usage();
  record.toolCalls = executor.trail;
  record.usage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };
  record.budgetTripped = outcome.budgetTripped;
}

async function redGateMode(stage: Stage): Promise<void> {
  const { inputs, pr, octokit, repoRoot, record, scrubber } = stage;

  if (!inputs.commentOnRedGate) {
    record.outcome = "abstain";
    return;
  }

  const failing = await fetchFailingStepLog(
    octokit,
    pr.owner,
    pr.repo,
    github.context.runId,
    inputs.gateJobName,
  );
  if (!failing) {
    record.outcome = "abstain";
    core.info("Could not find a failing gate step to investigate.");
    return;
  }
  const log = scrubber.scrub(failing.log);
  record.contextSizes.failingLogBytes = Buffer.byteLength(log);

  const infra = preclassify(log);
  if (infra) {
    record.preclassification = infra;
    record.outcome = "infra";
    record.postedId = await upsertComment(
      octokit,
      pr,
      RED_GATE_KEY,
      `### PR Verify: gate failed at \`${failing.stepName}\`\n\nThis looks like an infrastructure failure (${infra.label}), not the change:\n\n\`\`\`\n${infra.evidence}\n\`\`\`\n\nRe-run the job. [Run record](${stage.runUrl})`,
    );
    return;
  }

  const step = failing.stepName.toLowerCase();
  // With the gate's Semgrep run to repeat, a static analysis failure can get a verified fix like a test failure.
  const staticAnalysis =
    step === "static analysis" ? inputs.staticAnalysis : null;
  const scan = staticAnalysis ? null : scanFailure(failing.stepName);
  if (scan) {
    record.outcome = "scan";
    record.postedId = await upsertComment(
      octokit,
      pr,
      RED_GATE_KEY,
      `### PR Verify: gate failed at \`${failing.stepName}\`\n\n${scan} Not investigated: the agent cannot run the scanner, so it could not verify a fix. [Run record](${stage.runUrl})`,
    );
    return;
  }

  const isTestStep = step.includes("test");
  // A green suite says nothing about whether a build, lint or formatting fix works.
  const diagnosisOnly =
    step.includes("build") || step.includes("lint") || step === "code quality";
  const tree = new ScratchTree(
    repoRoot,
    pr.headSha,
    { build: inputs.buildCommand, test: inputs.testCommand },
    inputs.testTimeoutMs,
    await Sandbox.forRunner(),
  );

  if (isTestStep) {
    await tree.reset();
    const rerun = await tree.runTests();
    record.verification.testRuns += 1;
    record.verification.durationMs += rerun.durationMs;
    if (rerun.exitCode === 0) {
      record.outcome = "flaky";
      record.postedId = await upsertComment(
        octokit,
        pr,
        RED_GATE_KEY,
        `### PR Verify: gate failed at \`${failing.stepName}\`\n\nThe suite passed when re-run unchanged on this commit, so the failure looks flaky. Re-run the job, and consider the failing test suspect. [Run record](${stage.runUrl})`,
      );
      return;
    }
  }

  const [diff, tracked, guidance] = await Promise.all([
    collectDiff(pr, repoRoot),
    trackedFiles(repoRoot),
    readGuidance(repoRoot, inputs.guidanceFile),
  ]);
  const map = buildRepositoryMap(tracked);
  record.contextSizes.diffBytes = Buffer.byteLength(diff.text);
  record.contextSizes.repositoryMapBytes = Buffer.byteLength(map.text);
  record.contextSizes.guidanceBytes = guidance?.bytes ?? 0;

  const tooLarge = tooLargeNote(diff, inputs.limits);
  if (tooLarge) {
    record.outcome = "too-large";
    record.postedId = await upsertComment(
      octokit,
      pr,
      RED_GATE_KEY,
      `### PR Verify: gate failed at \`${failing.stepName}\`\n\nNot investigated. ${tooLarge} The failing step's log is in the run. [Run record](${stage.runUrl})`,
    );
    return;
  }

  const budget = new Budget(inputs.limits);
  const executor = new ToolExecutor({
    mode: "red-gate",
    repoRoot,
    tracked: new Set(tracked),
    budget,
    tree,
    patchLimits: inputs.patchLimits,
    scrubber,
  });
  const outcome = await runAgent({
    client: createClient(inputs.anthropicApiKey),
    model: inputs.model,
    mode: "red-gate",
    repositoryMap: map.text,
    brief: scrubber.scrub(
      buildRedGateBrief({
        diff: diff.text,
        omitted: diff.omitted,
        guidance: guidance?.text ?? null,
        stepName: failing.stepName,
        log,
      }),
    ),
    executor,
    budget,
  });
  recordAgentRun(record, executor, budget, outcome);

  if (outcome.finished?.mode !== "red-gate") {
    record.outcome = stoppedOutcome(outcome);
    await tree.reset();
    return;
  }

  const result = outcome.finished.result;
  let verdict = result.verdict;
  let fixPatch =
    result.fixPatch !== undefined
      ? executor.patches.find((p) => p.id === result.fixPatch)
      : undefined;
  let note = "";

  if (verdict === "fix" && diagnosisOnly && !isTestStep) {
    verdict = "diagnosis";
    fixPatch = undefined;
    note =
      "A fix was proposed but build and lint failures are diagnosed only, since no green suite can verify them.";
  }
  if (verdict === "fix" && fixPatch) {
    const scanned = staticAnalysis
      ? await verifyStaticAnalysisFix(tree, fixPatch, () =>
          countStaticAnalysisFindings(
            tree,
            staticAnalysis,
            inputs.testTimeoutMs,
          ),
        )
      : null;
    const verification = scanned ?? (await verifyRedGateFix(tree, fixPatch));
    record.verification.fixRuns += verification.runs;
    record.verification.durationMs += verification.durationMs;
    if (!verification.fixPasses) {
      verdict = "diagnosis";
      fixPatch = undefined;
      note = scanned
        ? staticAnalysisNote(scanned.findingsLeft)
        : "The proposed fix did not make the suite pass when re-run by the harness, so only the diagnosis is shown.";
    }
  }
  await tree.reset();

  if (verdict === "abstain") {
    record.outcome = "abstain";
    return;
  }

  const verified = staticAnalysis
    ? "**Verified fix.** Semgrep finds nothing and the suite passes with the patch below applied."
    : "**Verified fix.** The suite passes with the patch below applied.";
  const lines = [
    `### PR Verify: gate failed at \`${failing.stepName}\``,
    "",
    verdict === "fix" ? verified : "**Diagnosis.**",
    "",
    result.summary,
  ];
  if (result.citations.length > 0) {
    lines.push("", "Evidence:", ...result.citations.map((c) => `- ${c}`));
  }
  if (fixPatch) {
    lines.push(
      "",
      `<details><summary>${fixPatch.description}</summary>`,
      "",
      `\`\`\`diff\n${fixPatch.diff.trimEnd()}\n\`\`\``,
      "</details>",
    );
  }
  if (note) lines.push("", `_${note}_`);
  lines.push("", `[Run record](${stage.runUrl})`);

  record.postedId = await upsertComment(
    octokit,
    pr,
    RED_GATE_KEY,
    scrubber.scrub(lines.join("\n")),
  );
  record.outcome = verdict;
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

async function run(): Promise<void> {
  const startedAt = Date.now();
  const inputs = readInputs();
  const pr = pullRequestFromEvent();
  const mode: Mode = inputs.gateResult === "failure" ? "red-gate" : "review";
  const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const runUrl = `${github.context.serverUrl}/${pr.owner}/${pr.repo}/actions/runs/${String(github.context.runId)}`;

  const record = emptyRecord({
    runId: github.context.runId,
    repository: `${pr.owner}/${pr.repo}`,
    pullRequest: pr.number,
    headSha: pr.headSha,
    mode,
    gateResult: inputs.gateResult,
    model: inputs.model,
  });
  const scrubber = new Scrubber([inputs.anthropicApiKey, inputs.githubToken]);
  const stage: Stage = {
    inputs,
    pr,
    octokit: github.getOctokit(inputs.githubToken),
    repoRoot,
    record,
    scrubber,
    runUrl,
  };

  let outcome: Outcome;
  try {
    if (inputs.gateResult === "cancelled" || inputs.gateResult === "skipped") {
      record.outcome = "abstain";
      core.info(`Gate was ${inputs.gateResult}; nothing to do.`);
    } else if (mode === "review") {
      await reviewMode(stage);
    } else {
      await redGateMode(stage);
    }
    outcome = record.outcome;
  } catch (error) {
    record.outcome = "error";
    record.error = scrubber.scrub((error as Error).stack ?? String(error));
    throw error;
  } finally {
    record.wallMs = Date.now() - startedAt;
    core.setOutput("verdict", record.outcome);
    const file = await writeRecord(
      record,
      path.join(process.env.RUNNER_TEMP ?? repoRoot, "pr-verify"),
    );
    core.setOutput("record-path", file);
  }
  core.info(`PR Verify finished: ${outcome}`);
  if (outcome === "refused") {
    core.setFailed(
      "API refusal: the model declined to work on this pull request. Nothing was posted; the run record has the trail.",
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error : String(error));
});
