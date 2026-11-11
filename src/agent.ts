/**
 * The tool-use loop over the Messages API, and the two briefs. The loop owns
 * nothing clever: it sends a request, runs the tool calls that come back,
 * charges the budget, and stops when `finish` arrives or a budget trips.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Budget, BudgetExceeded, type BudgetName } from "./budget.js";
import { toolDefinitions } from "./tool-definitions.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { FinishPayload } from "./tool-input.js";
import type { Mode, Outcome, PriorFinding } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_OUTPUT_TOKENS = 16_000;
/** How many times the model may end a turn without calling finish before we stop asking. */
const MAX_NUDGES = 2;
/** The floor on one API request's timeout, so a nearly spent clock still gets a real attempt. */
const MIN_REQUEST_TIMEOUT_MS = 10_000;
const API_MAX_RETRIES = 2;
/** How many omitted file names the brief lists before summarizing the rest as a count. */
const OMITTED_SHOWN = 20;

const SHARED_RULES = `You are PR Verify, an automated reviewer running inside a CI job. You are advisory: a person decides what to do with what you say. You never approve, request changes, merge or push.

You have four tools and nothing else: read_file, run_tests, propose_patch and finish. There is no shell and no network. Paths are repository-relative. The working tree is the PR commit; propose_patch resets it and applies patches you choose, and run_tests runs the project's own suite on it.

Prefer silence to a weak claim. A reader who gets nothing from you learns that the change passed a careful look. A reader who gets a wrong finding learns to ignore you.

End every run by calling finish. Do not write a prose summary instead of calling it.`;

const REVIEW_SYSTEM_PROMPT = `${SHARED_RULES}

Your job in this run is to review a pull request whose build, tests and dependency audit already passed.

Look for, in this order:
1. Bugs: logic errors, wrong edge cases, broken invariants, error handling that swallows failures, concurrency mistakes.
2. Security: input reaching a shell, a query, a path or a template without escaping; secrets in code; unsafe deserialization; missing authorization checks; requests built from user input; crypto misuse.
3. Missing tests: a behavior the PR adds or changes with an obvious failure case that nothing exercises.

Never comment on style, naming, formatting, structure or "consider refactoring", and never praise.

The evidence rule: a claim about behavior must be demonstrated. Write the smallest test that shows the problem with propose_patch (kind "test"), then run_tests. The suite is green on this commit, so the suite going red with only your test added is the demonstration. If you can also fix it, propose a "fix" patch based on the test and run_tests again. Cite both patch ids in the finding. The harness re-runs these demonstrations itself from a clean tree; a test that does not fail there downgrades the finding to unverified.

A finding you cannot demonstrate by execution (most security findings, a race you can't reproduce, a missing test) may still be reported at medium or high confidence, with the exact lines and the data path it rests on. At most three such findings survive; choose the ones that matter.

Report a finding on a line outside the diff only when the PR's change is what exposes it.

Do not repeat a finding listed under "Already reported"; those are still open on the PR and the reader has seen them.`;

const RED_GATE_SYSTEM_PROMPT = `${SHARED_RULES}

Your job in this run is to investigate why the gate failed on this pull request. The failing step's log is in the brief. Infrastructure failures and flaky tests have already been ruled out by the harness.

If the failing step is the test step: find the cause, and if you can fix it, propose a "fix" patch and run_tests to confirm the suite passes. A verdict of "fix" must name a fix patch that made the suite pass in your run; the harness re-runs it.

If the failing step is the build step: diagnose only. You cannot verify a build fix with a green suite, so do not propose one.

If the failing step is static analysis: Semgrep flagged the code, and the log lists each finding with its rule and lines. Fix the code so the flagged pattern is gone, in one fix patch that clears every finding. Suppressing a finding is not a fix: nosemgrep comments are ignored and ignore files are off limits. You cannot run Semgrep, so use run_tests to check the suite still passes. The harness re-runs Semgrep and the suite on your patch and calls it verified only when Semgrep finds nothing and the suite passes.

End with finish: "fix" with the patch id, "diagnosis" with a three-line summary and citations when you can name the cause but not fix it, or "abstain" when you cannot say. An honest abstain is worth more than a guess.`;

/** Names the machine-written files left out of the diff, so the agent knows they changed. */
function omittedSection(omitted: string[]): string[] {
  if (omitted.length === 0) return [];
  const shown = omitted.slice(0, OMITTED_SHOWN).join(", ");
  const more =
    omitted.length > OMITTED_SHOWN
      ? `, and ${String(omitted.length - OMITTED_SHOWN)} more`
      : "";
  return [
    `## Left out of the diff\n\nThese changed files are machine-written (lockfiles, minified or generated) and are not shown: ${shown}${more}.`,
  ];
}

export interface ReviewBriefInput {
  diff: string;
  omitted: string[];
  guidance: string | null;
  openFindings: PriorFinding[];
  testConventions: string;
}

export function buildReviewBrief(input: ReviewBriefInput): string {
  const sections: string[] = [];
  if (input.guidance) {
    sections.push(
      `## Repository guidance (REVIEW.md)\n\n${input.guidance.trim()}`,
    );
  }
  sections.push(
    `## Test conventions inferred from the repository\n\n${input.testConventions}`,
  );
  if (input.openFindings.length > 0) {
    const list = input.openFindings
      .map(
        (f) =>
          `- ${f.file}:${String(f.line)} [${f.category}${f.verified ? ", verified" : ""}] ${f.title}`,
      )
      .join("\n");
    sections.push(`## Already reported on this pull request\n\n${list}`);
  }
  sections.push(
    `## Pull request diff\n\n\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``,
    ...omittedSection(input.omitted),
  );
  sections.push(
    "Review the change. Read whatever files you need, demonstrate what you can, then call finish.",
  );
  return sections.join("\n\n");
}

export interface RedGateBriefInput {
  diff: string;
  omitted: string[];
  guidance: string | null;
  stepName: string;
  log: string;
}

export function buildRedGateBrief(input: RedGateBriefInput): string {
  const sections: string[] = [];
  if (input.guidance) {
    sections.push(
      `## Repository guidance (REVIEW.md)\n\n${input.guidance.trim()}`,
    );
  }
  sections.push(`## Failing step\n\n\`${input.stepName}\``);
  sections.push(
    `## Log of the failing step\n\n\`\`\`\n${input.log.trimEnd()}\n\`\`\``,
  );
  sections.push(
    `## Pull request diff\n\n\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``,
    ...omittedSection(input.omitted),
  );
  sections.push("Investigate the failure, then call finish.");
  return sections.join("\n\n");
}

export interface AgentOutcome {
  finished: FinishPayload | null;
  budgetTripped: BudgetName | null;
  /** Why the loop ended when it ended without finish and without a budget. */
  stopReason: "refusal" | "max_tokens" | "no_finish" | "context_window" | null;
  turns: number;
}

/** The run outcome when the agent stopped without calling finish. A refusal is its own outcome so the job can fail on it. */
export function stoppedOutcome(outcome: AgentOutcome): Outcome {
  if (outcome.budgetTripped) return "budget";
  return outcome.stopReason === "refusal" ? "refused" : "abstain";
}

export interface AgentRunInput {
  client: Anthropic;
  model: string;
  mode: Mode;
  repositoryMap: string;
  brief: string;
  executor: ToolExecutor;
  budget: Budget;
}

function clearCacheBreakpoints(message: Anthropic.MessageParam): void {
  if (message.role !== "user" || typeof message.content === "string") return;
  for (const block of message.content) {
    if ("cache_control" in block) delete block.cache_control;
  }
}

/**
 * Puts the conversation's cache breakpoint on the newest user message and
 * takes it off the older ones. Each request then reads everything up to the
 * previous turn from the cache instead of paying for the brief and every tool
 * result again. With the two system breakpoints this uses three of the four
 * the API allows.
 */
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) clearCacheBreakpoints(message);
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return;
  if (typeof last.content === "string")
    last.content = [{ type: "text", text: last.content }];
  const block = last.content[last.content.length - 1];
  if (block && block.type !== "thinking" && block.type !== "redacted_thinking")
    block.cache_control = { type: "ephemeral" };
}

/** The system prompt as two cached blocks: the mode's rules, then the repository map. */
function systemBlocks(
  mode: Mode,
  repositoryMap: string,
): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: mode === "review" ? REVIEW_SYSTEM_PROMPT : RED_GATE_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `## Repository map\n\n${repositoryMap}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/** What the loop carries from one turn to the next. */
interface LoopState {
  messages: Anthropic.MessageParam[];
  turns: number;
  nudges: number;
}

/** The outcome of a run that ended without finish and without a budget. */
function stopped(
  stopReason: NonNullable<AgentOutcome["stopReason"]>,
  turns: number,
): AgentOutcome {
  return { finished: null, budgetTripped: null, stopReason, turns };
}

/** Runs a response's tool calls in order, and returns their results and the first finish among them. */
async function runToolCalls(
  content: Anthropic.ContentBlock[],
  executor: ToolExecutor,
): Promise<{
  results: Anthropic.ToolResultBlockParam[];
  finished: FinishPayload | null;
}> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  let finished: FinishPayload | null = null;
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    // Tools run one at a time: propose_patch and run_tests share the working tree.
    const result = await executor.execute(block);
    results.push(result.block);
    if (result.finished && !finished) finished = result.finished;
  }
  return { results, finished };
}

/** Asks a model that ended its turn without finish to call it, until it has been asked MAX_NUDGES times. */
function nudge(state: LoopState): AgentOutcome | null {
  if (state.nudges >= MAX_NUDGES) return stopped("no_finish", state.turns);
  state.nudges += 1;
  state.messages.push({
    role: "user",
    content:
      "Call finish to end the run. Report an empty list if there is nothing to report.",
  });
  return null;
}

/**
 * Acts on a response by its stop reason. Returns the run's outcome when the
 * run is over, or null when the conversation goes back to the model.
 */
async function afterResponse(
  response: Anthropic.Message,
  executor: ToolExecutor,
  state: LoopState,
): Promise<AgentOutcome | null> {
  switch (response.stop_reason) {
    case "tool_use": {
      const { results, finished } = await runToolCalls(
        response.content,
        executor,
      );
      if (finished) {
        return {
          finished,
          budgetTripped: null,
          stopReason: null,
          turns: state.turns,
        };
      }
      state.messages.push({ role: "user", content: results });
      return null;
    }
    case "pause_turn":
      return null;
    case "end_turn":
    case "stop_sequence":
      return nudge(state);
    case "max_tokens":
      return stopped("max_tokens", state.turns);
    case "refusal":
      return stopped("refusal", state.turns);
    case "model_context_window_exceeded":
      return stopped("context_window", state.turns);
    default:
      return stopped("no_finish", state.turns);
  }
}

export async function runAgent(input: AgentRunInput): Promise<AgentOutcome> {
  const { client, model, mode, executor, budget } = input;
  const system = systemBlocks(mode, input.repositoryMap);
  const tools = toolDefinitions(mode);
  const state: LoopState = {
    messages: [{ role: "user", content: input.brief }],
    turns: 0,
    nudges: 0,
  };
  const { messages } = state;

  try {
    let outcome: AgentOutcome | null = null;
    while (outcome === null) {
      budget.checkClock();
      state.turns += 1;
      moveCacheBreakpoint(messages);
      const response = await client.messages.create(
        { model, max_tokens: MAX_OUTPUT_TOKENS, system, tools, messages },
        { timeout: Math.max(MIN_REQUEST_TIMEOUT_MS, budget.remainingMs()) },
      );
      budget.chargeTokens({
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      });
      messages.push({ role: "assistant", content: response.content });
      outcome = await afterResponse(response, executor, state);
    }
    return outcome;
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return {
        finished: null,
        budgetTripped: error.budget,
        stopReason: null,
        turns: state.turns,
      };
    }
    throw error;
  }
}

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: API_MAX_RETRIES });
}
