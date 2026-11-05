/**
 * The tool-use loop over the Messages API, and the two briefs. The loop owns
 * nothing clever: it sends a request, runs the tool calls that come back,
 * charges the budget, and stops when `finish` arrives or a budget trips.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Budget, BudgetExceeded, type BudgetName } from "./budget.js";
import type { FinishPayload, ToolExecutor } from "./tools.js";
import { toolDefinitions } from "./tools.js";
import type { Mode, Outcome, PriorFinding } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_OUTPUT_TOKENS = 16_000;
/** How many times the model may end a turn without calling finish before we stop asking. */
const MAX_NUDGES = 2;

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
  const shown = omitted.slice(0, 20).join(", ");
  const more =
    omitted.length > 20 ? `, and ${String(omitted.length - 20)} more` : "";
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

/**
 * Puts the conversation's cache breakpoint on the newest user message and
 * takes it off the older ones. Each request then reads everything up to the
 * previous turn from the cache instead of paying for the brief and every tool
 * result again. With the two system breakpoints this uses three of the four
 * the API allows.
 */
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string")
      continue;
    for (const block of message.content) {
      if ("cache_control" in block) delete block.cache_control;
    }
  }
  const last = messages[messages.length - 1];
  if (last?.role !== "user") return;
  if (typeof last.content === "string")
    last.content = [{ type: "text", text: last.content }];
  const block = last.content[last.content.length - 1];
  if (block && block.type !== "thinking" && block.type !== "redacted_thinking")
    block.cache_control = { type: "ephemeral" };
}

export async function runAgent(input: AgentRunInput): Promise<AgentOutcome> {
  const { client, model, mode, executor, budget } = input;
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: mode === "review" ? REVIEW_SYSTEM_PROMPT : RED_GATE_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `## Repository map\n\n${input.repositoryMap}`,
      cache_control: { type: "ephemeral" },
    },
  ];
  const tools = toolDefinitions(mode);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: input.brief },
  ];
  let turns = 0;
  let nudges = 0;

  try {
    for (;;) {
      budget.checkClock();
      turns += 1;
      moveCacheBreakpoint(messages);
      const response = await client.messages.create(
        { model, max_tokens: MAX_OUTPUT_TOKENS, system, tools, messages },
        { timeout: Math.max(10_000, budget.remainingMs()) },
      );
      budget.chargeTokens({
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      });
      messages.push({ role: "assistant", content: response.content });

      switch (response.stop_reason) {
        case "tool_use": {
          const results: Anthropic.ToolResultBlockParam[] = [];
          let finished: FinishPayload | null = null;
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            // Tools run one at a time: propose_patch and run_tests share the working tree.
            const result = await executor.execute(block);
            results.push(result.block);
            if (result.finished && !finished) finished = result.finished;
          }
          if (finished)
            return { finished, budgetTripped: null, stopReason: null, turns };
          messages.push({ role: "user", content: results });
          continue;
        }
        case "pause_turn":
          continue;
        case "end_turn":
        case "stop_sequence": {
          if (nudges >= MAX_NUDGES)
            return {
              finished: null,
              budgetTripped: null,
              stopReason: "no_finish",
              turns,
            };
          nudges += 1;
          messages.push({
            role: "user",
            content:
              "Call finish to end the run. Report an empty list if there is nothing to report.",
          });
          continue;
        }
        case "max_tokens":
          return {
            finished: null,
            budgetTripped: null,
            stopReason: "max_tokens",
            turns,
          };
        case "refusal":
          return {
            finished: null,
            budgetTripped: null,
            stopReason: "refusal",
            turns,
          };
        case "model_context_window_exceeded":
          return {
            finished: null,
            budgetTripped: null,
            stopReason: "context_window",
            turns,
          };
        default:
          return {
            finished: null,
            budgetTripped: null,
            stopReason: "no_finish",
            turns,
          };
      }
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return {
        finished: null,
        budgetTripped: error.budget,
        stopReason: null,
        turns,
      };
    }
    throw error;
  }
}

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 2 });
}
