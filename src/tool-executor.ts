/**
 * Runs the agent's tool calls. Every call passes through
 * `ToolExecutor.execute`, which charges the budget, checks the input, records
 * the call for the run record, and returns a result the model can read.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { BYTES_PER_KB, type Budget } from "./budget.js";
import type { Scrubber } from "./context.js";
import { applyHints, recountHunks } from "./patch-repair.js";
import { checkPatchPolicy, type PatchLimits } from "./patch-policy.js";
import type { ScratchTree } from "./scratch-tree.js";
import {
  READ_FILE_LIMIT_KB,
  READ_FILE_LIMIT_LINES,
} from "./tool-definitions.js";
import {
  expectInteger,
  expectString,
  parseFinish,
  resolveTracked,
  ToolInputError,
  type FinishPayload,
} from "./tool-input.js";
import type { Mode, Patch, PatchKind } from "./types.js";

const READ_FILE_LIMIT_BYTES = READ_FILE_LIMIT_KB * BYTES_PER_KB;

/** How much of a rejected patch the run record keeps. */
const PREVIEW_BYTES = 2048;

export interface ToolCallRecord {
  n: number;
  tool: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  durationMs: number;
}

export interface ToolContext {
  mode: Mode;
  repoRoot: string;
  tracked: ReadonlySet<string>;
  budget: Budget;
  tree: ScratchTree;
  patchLimits: PatchLimits;
  scrubber: Scrubber;
}

export interface ExecutionResult {
  block: Anthropic.ToolResultBlockParam;
  finished: FinishPayload | null;
}

/** What one call produced: the text the model reads and the response the trail records. */
interface CallOutcome {
  content: string;
  response: Record<string, unknown>;
  isError: boolean;
  finished: FinishPayload | null;
}

/** What a propose_patch call produced. */
interface PatchOutcome {
  ok: boolean;
  text: string;
  response: Record<string, unknown>;
}

/** A propose_patch call's input, checked, with the accepted patches it is based on. */
interface Proposal {
  kind: PatchKind;
  description: string;
  /** The diff as the agent sent it. */
  sent: string;
  /** The diff with its hunk counts recounted. */
  diff: string;
  baseOn: number[];
  bases: Patch[];
}

export class ToolExecutor {
  readonly patches: Patch[] = [];
  readonly trail: ToolCallRecord[] = [];
  readonly filesRead = new Set<string>();

  constructor(private readonly ctx: ToolContext) {}

  async execute(block: Anthropic.ToolUseBlock): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const input = (block.input ?? {}) as Record<string, unknown>;
    this.ctx.budget.chargeToolCall();

    let outcome: CallOutcome;
    try {
      outcome = await this.dispatch(block.name, input);
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error;
      outcome = {
        content: `Invalid call: ${error.message}`,
        response: { error: error.message },
        isError: true,
        finished: null,
      };
    }

    const request = this.summarizeRequest(block.name, input);
    this.trail.push({
      n: this.trail.length + 1,
      tool: block.name,
      request,
      response: outcome.response,
      durationMs: Date.now() - startedAt,
    });

    return {
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content: this.ctx.scrubber.scrub(outcome.content),
        ...(outcome.isError ? { is_error: true } : {}),
      },
      finished: outcome.finished,
    };
  }

  private async dispatch(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<CallOutcome> {
    switch (tool) {
      case "read_file": {
        const out = await this.readFile(input);
        const response = {
          bytes: Buffer.byteLength(out.text),
          lines: out.lines,
          truncated: out.truncated,
        };
        return { content: out.text, response, isError: false, finished: null };
      }
      case "run_tests": {
        const out = await this.runTests();
        const response = {
          exitCode: out.exitCode,
          timedOut: out.timedOut,
          bytes: Buffer.byteLength(out.text),
        };
        return { content: out.text, response, isError: false, finished: null };
      }
      case "propose_patch": {
        const out = await this.proposePatch(input);
        return {
          content: out.text,
          response: out.response,
          isError: !out.ok,
          finished: null,
        };
      }
      case "finish": {
        const finished = parseFinish(input, {
          mode: this.ctx.mode,
          tracked: this.ctx.tracked,
          patches: this.patches,
        });
        return {
          content: "Run finished.",
          response: { accepted: true },
          isError: false,
          finished,
        };
      }
      default:
        throw new ToolInputError(`unknown tool "${tool}"`);
    }
  }

  private summarizeRequest(
    tool: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    if (tool === "propose_patch") {
      const policy = checkPatchPolicy(
        typeof input.diff === "string" ? input.diff : "",
        input.kind === "test" ? "test" : "fix",
        {
          maxLines: Number.MAX_SAFE_INTEGER,
          maxFiles: Number.MAX_SAFE_INTEGER,
        },
      );
      return {
        kind: input.kind,
        description: input.description,
        files: policy.files.map((f) => ({
          path: f.path,
          added: f.added,
          removed: f.removed,
        })),
      };
    }
    if (tool === "finish") return { keys: Object.keys(input) };
    return input;
  }

  private async readFile(input: Record<string, unknown>) {
    const relative = resolveTracked(
      expectString(input, "path"),
      this.ctx.tracked,
    );
    const start = expectInteger(input, "start_line", true) ?? 1;
    const requestedEnd = expectInteger(input, "end_line", true);
    if (start < 1) throw new ToolInputError('"start_line" must be at least 1');
    if (requestedEnd !== undefined && requestedEnd < start) {
      throw new ToolInputError('"end_line" must not be before "start_line"');
    }

    const raw = await readFile(path.join(this.ctx.repoRoot, relative), "utf8");
    const all = raw.split("\n");
    if (raw.endsWith("\n")) all.pop(); // the final newline ends the last line; it does not start another
    const wantedEnd = Math.min(requestedEnd ?? all.length, all.length);
    const end = Math.min(wantedEnd, start - 1 + READ_FILE_LIMIT_LINES);
    const slice = all.slice(start - 1, end);

    const numbered: string[] = [];
    let bytes = 0;
    // Truncated means a cap cut the read short, not that end_line ran past the end of the file.
    let truncated = end < wantedEnd;
    for (const [i, text] of slice.entries()) {
      const line = `${String(start + i)}\t${text}`;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > READ_FILE_LIMIT_BYTES) {
        truncated = true;
        break;
      }
      numbered.push(line);
    }
    this.filesRead.add(relative);

    const lastShown = start + numbered.length - 1;
    const footer = truncated
      ? `\n[truncated: showing lines ${String(start)}-${String(lastShown)} of ${String(all.length)}]`
      : "";
    return {
      text: numbered.join("\n") + footer,
      lines: numbered.length,
      truncated,
    };
  }

  private async runTests() {
    this.ctx.budget.chargeTestRun();
    const result = await this.ctx.tree.runTests();
    const status = result.timedOut
      ? "timed out"
      : `exit code ${String(result.exitCode)}`;
    return {
      text: `Test run ${status}.\n\n${result.output}`,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  }

  /** The start of a rejected patch, scrubbed, so the run record shows what the agent actually sent. */
  private preview(diff: string): string {
    const clipped =
      diff.length > PREVIEW_BYTES
        ? `${diff.slice(0, PREVIEW_BYTES)}\n[truncated]`
        : diff;
    return this.ctx.scrubber.scrub(clipped);
  }

  private async proposePatch(
    input: Record<string, unknown>,
  ): Promise<PatchOutcome> {
    const proposal = this.readProposal(input);
    const { kind, description, sent, diff, baseOn } = proposal;

    this.ctx.budget.chargePatchAttempt();

    const policy = checkPatchPolicy(diff, kind, this.ctx.patchLimits);
    if (!policy.ok) {
      return {
        ok: false,
        text: `Patch rejected by policy:\n- ${policy.violations.join("\n- ")}`,
        response: {
          applied: false,
          violations: policy.violations,
          diffPreview: this.preview(sent),
        },
      };
    }

    const failure = await this.applyOnCleanTree(proposal);
    if (failure) return failure;

    const patch: Patch = {
      id: this.patches.length + 1,
      kind,
      description,
      diff,
    };
    this.patches.push(patch);
    return {
      ok: true,
      text: `Patch ${String(patch.id)} (${kind}) applied. The working tree now holds the PR commit plus patches [${[...baseOn, patch.id].join(", ")}]. Run run_tests to see its effect.`,
      response: { applied: true, patchId: patch.id, baseOn },
    };
  }

  private readProposal(input: Record<string, unknown>): Proposal {
    const kind = expectString(input, "kind");
    if (kind !== "test" && kind !== "fix")
      throw new ToolInputError('"kind" must be "test" or "fix"');
    const description = expectString(input, "description");
    const sent = expectString(input, "diff");
    // Policy, apply and the posted comment all use the recounted patch; previews show what was sent.
    const diff = recountHunks(sent);
    const baseOnRaw = input.base_on;
    const baseOn: number[] = Array.isArray(baseOnRaw)
      ? baseOnRaw.map(Number)
      : [];
    const bases = baseOn.map((id) => {
      const found = this.patches.find((p) => p.id === id);
      if (!found)
        throw new ToolInputError(
          `base_on references unknown patch id ${String(id)}`,
        );
      return found;
    });
    return { kind, description, sent, diff, baseOn, bases };
  }

  /** Resets the tree, applies the bases in order, then the proposal. Null when every one applied. */
  private async applyOnCleanTree(
    proposal: Proposal,
  ): Promise<PatchOutcome | null> {
    await this.ctx.tree.reset();
    for (const base of proposal.bases) {
      const applied = await this.ctx.tree.apply(base.diff);
      if (!applied.applied) {
        return {
          ok: false,
          text: `Could not re-apply base patch ${String(base.id)}: ${applied.error ?? "unknown error"}`,
          response: { applied: false, failedBase: base.id },
        };
      }
    }
    const applied = await this.ctx.tree.apply(proposal.diff);
    if (applied.applied) return null;
    const hints = applyHints(proposal.diff);
    const hintText =
      hints.length > 0 ? `\n\nLikely cause:\n- ${hints.join("\n- ")}` : "";
    return {
      ok: false,
      text: `Patch did not apply cleanly to the PR commit:\n${applied.error ?? "unknown error"}${hintText}`,
      response: {
        applied: false,
        error: applied.error,
        hints,
        diffPreview: this.preview(proposal.sent),
      },
    };
  }
}
