/**
 * The agent's four tools and the limits on each. Every call passes through
 * `ToolExecutor.execute`, which charges the budget, checks the input, records
 * the call for the run record, and returns a result the model can read.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Budget } from "./budget.js";
import type { Scrubber } from "./context.js";
import { applyHints, recountHunks } from "./diff.js";
import type {
  Mode,
  Patch,
  PatchKind,
  ProposedFinding,
  RedGateResult,
} from "./types.js";
import {
  checkPatchPolicy,
  type PatchLimits,
  type ScratchTree,
} from "./verify.js";

export const READ_FILE_MAX_LINES = 400;
export const READ_FILE_MAX_BYTES = 32 * 1024;

const CATEGORIES = new Set(["bug", "security", "missing-test"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const VERDICTS = new Set(["fix", "diagnosis", "abstain"]);

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

export type FinishPayload =
  | { mode: "review"; findings: ProposedFinding[] }
  | { mode: "red-gate"; result: RedGateResult };

export interface ExecutionResult {
  block: Anthropic.ToolResultBlockParam;
  finished: FinishPayload | null;
}

class ToolInputError extends Error {}

function expectString(input: Record<string, unknown>, key: string): string;
function expectString(
  input: Record<string, unknown>,
  key: string,
  optional: true,
): string | undefined;
function expectString(
  input: Record<string, unknown>,
  key: string,
  optional = false,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ToolInputError(`"${key}" is required`);
  }
  if (typeof value !== "string")
    throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

function expectInteger(input: Record<string, unknown>, key: string): number;
function expectInteger(
  input: Record<string, unknown>,
  key: string,
  optional: true,
): number | undefined;
function expectInteger(
  input: Record<string, unknown>,
  key: string,
  optional = false,
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ToolInputError(`"${key}" is required`);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolInputError(`"${key}" must be an integer`);
  }
  return value;
}

export function toolDefinitions(mode: Mode): Anthropic.Tool[] {
  const finish: Anthropic.Tool =
    mode === "review"
      ? {
          name: "finish",
          description:
            "End the review. Report only findings that meet the bar: bugs, security problems and missing tests, each citing the exact file and line. A behavior claim must reference a test patch that fails on the PR commit. Report an empty list when the change is clean.",
          input_schema: {
            type: "object",
            properties: {
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    category: {
                      type: "string",
                      enum: ["bug", "security", "missing-test"],
                    },
                    confidence: {
                      type: "string",
                      enum: ["low", "medium", "high"],
                    },
                    file: {
                      type: "string",
                      description: "Repository-relative path.",
                    },
                    line: {
                      type: "integer",
                      description:
                        "1-based line in the PR head version of the file.",
                    },
                    title: { type: "string", description: "One line." },
                    explanation: {
                      type: "string",
                      description: "At most four lines.",
                    },
                    test_patch: {
                      type: "integer",
                      description:
                        "Id of the accepted test patch that demonstrates this finding.",
                    },
                    fix_patch: {
                      type: "integer",
                      description:
                        "Id of the accepted fix patch that makes the test pass.",
                    },
                  },
                  required: [
                    "category",
                    "confidence",
                    "file",
                    "line",
                    "title",
                    "explanation",
                  ],
                },
              },
            },
            required: ["findings"],
          },
        }
      : {
          name: "finish",
          description:
            'End the investigation with a verdict: "fix" when an accepted fix patch makes the suite pass, "diagnosis" when you can name the cause with evidence but not fix it, "abstain" when you cannot say.',
          input_schema: {
            type: "object",
            properties: {
              verdict: {
                type: "string",
                enum: ["fix", "diagnosis", "abstain"],
              },
              summary: { type: "string", description: "At most three lines." },
              citations: {
                type: "array",
                items: { type: "string" },
                description:
                  "File:line references and log lines the verdict rests on.",
              },
              fix_patch: {
                type: "integer",
                description:
                  'Id of the accepted fix patch, for a "fix" verdict.',
              },
            },
            required: ["verdict", "summary", "citations"],
          },
        };

  return [
    {
      name: "read_file",
      description: `Read a tracked file from the repository at the PR commit. Returns at most ${READ_FILE_MAX_LINES} lines or ${READ_FILE_MAX_BYTES / 1024} KB per call; use start_line and end_line to read further.`,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path." },
          start_line: {
            type: "integer",
            description: "1-based first line to return.",
          },
          end_line: {
            type: "integer",
            description: "1-based last line to return, inclusive.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "run_tests",
      description:
        "Run the configured test command on the working tree as it currently stands (the PR commit plus any patches applied by your most recent propose_patch). Returns the exit code and the tail of the output.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "propose_patch",
      description:
        'Propose a unified diff against the PR commit. The tree is reset, the patches listed in base_on are applied in order, then this one. A "test" patch may only add tests; a "fix" patch may not touch only tests. Returns the patch id to cite in finish.',
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["test", "fix"] },
          description: { type: "string", description: "One line." },
          diff: {
            type: "string",
            description:
              "Unified diff with a/ and b/ prefixes, as git produces.",
          },
          base_on: {
            type: "array",
            items: { type: "integer" },
            description:
              "Ids of earlier accepted patches to apply before this one (a fix is usually based on its test).",
          },
        },
        required: ["kind", "description", "diff"],
      },
    },
    finish,
  ];
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

    let content: string;
    let isError = false;
    let finished: FinishPayload | null = null;
    let response: Record<string, unknown> = {};

    try {
      switch (block.name) {
        case "read_file": {
          const out = await this.readFile(input);
          content = out.text;
          response = {
            bytes: Buffer.byteLength(out.text),
            lines: out.lines,
            truncated: out.truncated,
          };
          break;
        }
        case "run_tests": {
          const out = await this.runTests();
          content = out.text;
          response = {
            exitCode: out.exitCode,
            timedOut: out.timedOut,
            bytes: Buffer.byteLength(out.text),
          };
          break;
        }
        case "propose_patch": {
          const out = await this.proposePatch(input);
          content = out.text;
          response = out.response;
          isError = !out.ok;
          break;
        }
        case "finish": {
          finished = this.parseFinish(input);
          content = "Run finished.";
          response = { accepted: true };
          break;
        }
        default:
          throw new ToolInputError(`unknown tool "${block.name}"`);
      }
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error;
      isError = true;
      content = `Invalid call: ${error.message}`;
      response = { error: error.message };
    }

    const request = this.summarizeRequest(block.name, input);
    this.trail.push({
      n: this.trail.length + 1,
      tool: block.name,
      request,
      response,
      durationMs: Date.now() - startedAt,
    });

    return {
      block: {
        type: "tool_result",
        tool_use_id: block.id,
        content: this.ctx.scrubber.scrub(content),
        ...(isError ? { is_error: true } : {}),
      },
      finished,
    };
  }

  private summarizeRequest(
    tool: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    if (tool === "propose_patch") {
      const policy = checkPatchPolicy(
        String(input["diff"] ?? ""),
        (input["kind"] as PatchKind) ?? "fix",
        {
          maxLines: Number.MAX_SAFE_INTEGER,
          maxFiles: Number.MAX_SAFE_INTEGER,
        },
      );
      return {
        kind: input["kind"],
        description: input["description"],
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

  private resolveTracked(relative: string): string {
    const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      /^[A-Za-z]:/.test(normalized)
    ) {
      throw new ToolInputError(`"${relative}" resolves outside the repository`);
    }
    if (!this.ctx.tracked.has(normalized)) {
      throw new ToolInputError(
        `"${relative}" is not a tracked file in this repository`,
      );
    }
    return normalized;
  }

  private async readFile(input: Record<string, unknown>) {
    const relative = this.resolveTracked(expectString(input, "path"));
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
    const end = Math.min(wantedEnd, start - 1 + READ_FILE_MAX_LINES);
    const slice = all.slice(start - 1, end);

    const numbered: string[] = [];
    let bytes = 0;
    // Truncated means a cap cut the read short, not that end_line ran past the end of the file.
    let truncated = end < wantedEnd;
    for (let i = 0; i < slice.length; i += 1) {
      const line = `${start + i}\t${slice[i]}`;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > READ_FILE_MAX_BYTES) {
        truncated = true;
        break;
      }
      numbered.push(line);
    }
    this.filesRead.add(relative);

    const lastShown = start + numbered.length - 1;
    const footer = truncated
      ? `\n[truncated: showing lines ${start}-${lastShown} of ${all.length}]`
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
      : `exit code ${result.exitCode}`;
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

  private async proposePatch(input: Record<string, unknown>) {
    const kind = expectString(input, "kind");
    if (kind !== "test" && kind !== "fix")
      throw new ToolInputError('"kind" must be "test" or "fix"');
    const description = expectString(input, "description");
    const sent = expectString(input, "diff");
    // Policy, apply and the posted comment all use the recounted patch; previews show what was sent.
    const diff = recountHunks(sent);
    const baseOnRaw = input["base_on"];
    const baseOn: number[] = Array.isArray(baseOnRaw)
      ? baseOnRaw.map(Number)
      : [];
    const bases = baseOn.map((id) => {
      const found = this.patches.find((p) => p.id === id);
      if (!found)
        throw new ToolInputError(`base_on references unknown patch id ${id}`);
      return found;
    });

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

    await this.ctx.tree.reset();
    for (const base of bases) {
      const applied = await this.ctx.tree.apply(base.diff);
      if (!applied.applied) {
        return {
          ok: false,
          text: `Could not re-apply base patch ${base.id}: ${applied.error ?? "unknown error"}`,
          response: { applied: false, failedBase: base.id },
        };
      }
    }
    const applied = await this.ctx.tree.apply(diff);
    if (!applied.applied) {
      const hints = applyHints(diff);
      const hintText =
        hints.length > 0 ? `\n\nLikely cause:\n- ${hints.join("\n- ")}` : "";
      return {
        ok: false,
        text: `Patch did not apply cleanly to the PR commit:\n${applied.error ?? "unknown error"}${hintText}`,
        response: {
          applied: false,
          error: applied.error,
          hints,
          diffPreview: this.preview(sent),
        },
      };
    }

    const patch: Patch = {
      id: this.patches.length + 1,
      kind,
      description,
      diff,
    };
    this.patches.push(patch);
    return {
      ok: true,
      text: `Patch ${patch.id} (${kind}) applied. The working tree now holds the PR commit plus patches [${[...baseOn, patch.id].join(", ")}]. Run run_tests to see its effect.`,
      response: { applied: true, patchId: patch.id, baseOn },
    };
  }

  private parseFinish(input: Record<string, unknown>): FinishPayload {
    if (this.ctx.mode === "review") {
      const raw = input["findings"];
      if (!Array.isArray(raw))
        throw new ToolInputError('"findings" must be an array');
      const findings = raw.map((item, index) => this.parseFinding(item, index));
      return { mode: "review", findings };
    }

    const verdict = expectString(input, "verdict");
    if (!VERDICTS.has(verdict))
      throw new ToolInputError('"verdict" must be fix, diagnosis or abstain');
    const summary = expectString(input, "summary");
    const citations = Array.isArray(input["citations"])
      ? input["citations"].map(String)
      : [];
    const fixPatch = expectInteger(input, "fix_patch", true);
    if (verdict === "fix" && fixPatch === undefined) {
      throw new ToolInputError('a "fix" verdict must name its fix_patch');
    }
    if (fixPatch !== undefined) this.requirePatch(fixPatch, "fix");
    return {
      mode: "red-gate",
      result: {
        verdict: verdict as RedGateResult["verdict"],
        summary: clipLines(summary, 3),
        citations,
        ...(fixPatch !== undefined ? { fixPatch } : {}),
      },
    };
  }

  private parseFinding(item: unknown, index: number): ProposedFinding {
    if (typeof item !== "object" || item === null)
      throw new ToolInputError(`findings[${index}] must be an object`);
    const f = item as Record<string, unknown>;
    const category = expectString(f, "category");
    if (!CATEGORIES.has(category))
      throw new ToolInputError(`findings[${index}].category is invalid`);
    const confidence = expectString(f, "confidence");
    if (!CONFIDENCES.has(confidence))
      throw new ToolInputError(`findings[${index}].confidence is invalid`);
    const file = this.resolveTracked(expectString(f, "file"));
    const line = expectInteger(f, "line");
    if (line < 1)
      throw new ToolInputError(`findings[${index}].line must be at least 1`);
    const testPatch = expectInteger(f, "test_patch", true);
    const fixPatch = expectInteger(f, "fix_patch", true);
    if (testPatch !== undefined) this.requirePatch(testPatch, "test");
    if (fixPatch !== undefined) this.requirePatch(fixPatch, "fix");
    if (fixPatch !== undefined && testPatch === undefined) {
      throw new ToolInputError(
        `findings[${index}] names a fix_patch without a test_patch`,
      );
    }
    return {
      category: category as ProposedFinding["category"],
      confidence: confidence as ProposedFinding["confidence"],
      file,
      line,
      title: clipLines(expectString(f, "title"), 1),
      explanation: clipLines(expectString(f, "explanation"), 4),
      ...(testPatch !== undefined ? { testPatch } : {}),
      ...(fixPatch !== undefined ? { fixPatch } : {}),
    };
  }

  private requirePatch(id: number, kind: PatchKind): void {
    const patch = this.patches.find((p) => p.id === id);
    if (!patch) throw new ToolInputError(`patch ${id} does not exist`);
    if (patch.kind !== kind)
      throw new ToolInputError(
        `patch ${id} is a ${patch.kind} patch, not a ${kind} patch`,
      );
  }
}

export function clipLines(text: string, maxLines: number): string {
  return text.trim().split("\n").slice(0, maxLines).join("\n");
}
