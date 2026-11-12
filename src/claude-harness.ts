/**
 * The harness around Claude: the tool-use loop over the Messages API. It owns
 * nothing clever: it sends a request, runs the tool calls that come back,
 * charges the budget, and stops when `finish` arrives or a budget trips.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Budget, BudgetExceeded, type BudgetName } from "./budget.js";
import { systemPrompt } from "./claude-prompts.js";
import { toolDefinitions } from "./tool-definitions.js";
import type { ToolExecutor } from "./tool-executor.js";
import type { FinishPayload } from "./tool-input.js";
import type { Mode, Outcome } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_OUTPUT_TOKENS = 16_000;
/** How many times the model may end a turn without calling finish before we stop asking. */
const MAX_NUDGES = 2;
/** The floor on one API request's timeout, so a nearly spent clock still gets a real attempt. */
const MIN_REQUEST_TIMEOUT_MS = 10_000;
const API_MAX_RETRIES = 2;
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
      text: systemPrompt(mode),
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
