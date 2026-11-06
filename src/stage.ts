/**
 * What both modes share: the stage a mode runs on, the keys of the comments
 * the modes keep up to date, and the pieces they build the same way.
 */

import * as github from "@actions/github";
import type { AgentOutcome } from "./agent.js";
import type { Budget } from "./budget.js";
import { Scrubber, type Octokit } from "./context.js";
import type { Inputs } from "./inputs.js";
import { emptyRecord, type RunRecord } from "./record.js";
import { Sandbox } from "./sandbox.js";
import type { ToolExecutor } from "./tools.js";
import type { Mode, PullRequestRef } from "./types.js";
import { ScratchTree } from "./verify.js";

export interface Stage {
  inputs: Inputs;
  pr: PullRequestRef;
  octokit: Octokit;
  repoRoot: string;
  record: RunRecord;
  scrubber: Scrubber;
  runUrl: string;
}

/** The agent's run, kept for verification and the run record. */
export interface AgentRun {
  outcome: AgentOutcome;
  executor: ToolExecutor;
  budget: Budget;
}

export const TOO_LARGE_KEY = "too-large";
export const RED_GATE_KEY = "red-gate";
export const BASELINE_KEY = "baseline";

/** The stage for this run, with an empty record for the chosen mode. */
export function createStage(
  inputs: Inputs,
  pr: PullRequestRef,
  mode: Mode,
): Stage {
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
  return {
    inputs,
    pr,
    octokit: github.getOctokit(inputs.githubToken),
    repoRoot,
    record,
    scrubber,
    runUrl,
  };
}

/** The runner's checkout as a scratch tree at the PR commit, running the project's own commands in the sandbox. */
export async function createScratchTree(stage: Stage): Promise<ScratchTree> {
  const { inputs } = stage;
  return new ScratchTree(
    stage.repoRoot,
    stage.pr.headSha,
    { build: inputs.buildCommand, test: inputs.testCommand },
    inputs.testTimeoutMs,
    await Sandbox.forRunner(),
  );
}

export function recordAgentRun(
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
