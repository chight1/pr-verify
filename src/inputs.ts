/**
 * The action's inputs and the pull request it runs on, read once at the start
 * and checked so a bad value fails the run before any stage starts.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { DEFAULT_MODEL } from "./claude-harness.js";
import { MS_PER_MINUTE, type BudgetLimits } from "./budget.js";
import type { PatchLimits } from "./patch-policy.js";
import type { StaticAnalysis } from "./proof.js";
import type { GateResult, PullRequestRef } from "./types.js";

export interface Inputs {
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

export function readInputs(): Inputs {
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
    testTimeoutMs: integerInput("test-timeout-minutes") * MS_PER_MINUTE,
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

export function pullRequestFromEvent(): PullRequestRef {
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
