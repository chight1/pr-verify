/**
 * Reads the model's tool input into typed values: required and optional
 * fields, repository paths, and the finish payload of either mode. Anything
 * malformed throws a ToolInputError, which the executor hands back to the
 * model as an invalid call instead of failing the run.
 */

import path from "node:path";
import type {
  Mode,
  Patch,
  PatchKind,
  ProposedFinding,
  RedGateResult,
} from "./types.js";

const SUMMARY_MAX_LINES = 3;
const EXPLANATION_MAX_LINES = 4;

const CATEGORIES = new Set(["bug", "security", "missing-test"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const VERDICTS = new Set(["fix", "diagnosis", "abstain"]);

export class ToolInputError extends Error {}

export function expectString(
  input: Record<string, unknown>,
  key: string,
): string;
export function expectString(
  input: Record<string, unknown>,
  key: string,
  optional: true,
): string | undefined;
export function expectString(
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

export function expectInteger(
  input: Record<string, unknown>,
  key: string,
): number;
export function expectInteger(
  input: Record<string, unknown>,
  key: string,
  optional: true,
): number | undefined;
export function expectInteger(
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

/** A path the model sent, normalized, when it names a file the repository tracks. */
export function resolveTracked(
  relative: string,
  tracked: ReadonlySet<string>,
): string {
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new ToolInputError(`"${relative}" resolves outside the repository`);
  }
  if (!tracked.has(normalized)) {
    throw new ToolInputError(
      `"${relative}" is not a tracked file in this repository`,
    );
  }
  return normalized;
}

export type FinishPayload =
  | { mode: "review"; findings: ProposedFinding[] }
  | { mode: "red-gate"; result: RedGateResult };

/** What a finish call is checked against: the mode, the tracked files, and the patches accepted so far. */
export interface FinishContext {
  mode: Mode;
  tracked: ReadonlySet<string>;
  patches: readonly Patch[];
}

export function parseFinish(
  input: Record<string, unknown>,
  context: FinishContext,
): FinishPayload {
  if (context.mode === "review") {
    const raw = input.findings;
    if (!Array.isArray(raw))
      throw new ToolInputError('"findings" must be an array');
    const findings = raw.map((item, index) =>
      parseFinding(item, index, context),
    );
    return { mode: "review", findings };
  }

  const verdict = expectString(input, "verdict");
  if (!VERDICTS.has(verdict))
    throw new ToolInputError('"verdict" must be fix, diagnosis or abstain');
  const summary = expectString(input, "summary");
  const citations = Array.isArray(input.citations)
    ? input.citations.map(String)
    : [];
  const fixPatch = expectInteger(input, "fix_patch", true);
  if (verdict === "fix" && fixPatch === undefined) {
    throw new ToolInputError('a "fix" verdict must name its fix_patch');
  }
  if (fixPatch !== undefined) requirePatch(context.patches, fixPatch, "fix");
  return {
    mode: "red-gate",
    result: {
      verdict: verdict as RedGateResult["verdict"],
      summary: clipLines(summary, SUMMARY_MAX_LINES),
      citations,
      ...(fixPatch !== undefined ? { fixPatch } : {}),
    },
  };
}

function parseFinding(
  item: unknown,
  index: number,
  context: FinishContext,
): ProposedFinding {
  if (typeof item !== "object" || item === null)
    throw new ToolInputError(`findings[${String(index)}] must be an object`);
  const f = item as Record<string, unknown>;
  const category = expectString(f, "category");
  if (!CATEGORIES.has(category))
    throw new ToolInputError(`findings[${String(index)}].category is invalid`);
  const confidence = expectString(f, "confidence");
  if (!CONFIDENCES.has(confidence))
    throw new ToolInputError(
      `findings[${String(index)}].confidence is invalid`,
    );
  const file = resolveTracked(expectString(f, "file"), context.tracked);
  const line = expectInteger(f, "line");
  if (line < 1)
    throw new ToolInputError(
      `findings[${String(index)}].line must be at least 1`,
    );
  const patches = citedPatches(f, index, context.patches);
  return {
    category: category as ProposedFinding["category"],
    confidence: confidence as ProposedFinding["confidence"],
    file,
    line,
    title: clipLines(expectString(f, "title"), 1),
    explanation: clipLines(
      expectString(f, "explanation"),
      EXPLANATION_MAX_LINES,
    ),
    ...patches,
  };
}

/** The test and fix patches a finding cites, each an accepted patch of its kind; a fix needs its test. */
function citedPatches(
  f: Record<string, unknown>,
  index: number,
  patches: readonly Patch[],
): Pick<ProposedFinding, "testPatch" | "fixPatch"> {
  const testPatch = expectInteger(f, "test_patch", true);
  const fixPatch = expectInteger(f, "fix_patch", true);
  if (testPatch !== undefined) requirePatch(patches, testPatch, "test");
  if (fixPatch !== undefined) requirePatch(patches, fixPatch, "fix");
  if (fixPatch !== undefined && testPatch === undefined) {
    throw new ToolInputError(
      `findings[${String(index)}] names a fix_patch without a test_patch`,
    );
  }
  return {
    ...(testPatch !== undefined ? { testPatch } : {}),
    ...(fixPatch !== undefined ? { fixPatch } : {}),
  };
}

function requirePatch(
  patches: readonly Patch[],
  id: number,
  kind: PatchKind,
): void {
  const patch = patches.find((p) => p.id === id);
  if (!patch) throw new ToolInputError(`patch ${String(id)} does not exist`);
  if (patch.kind !== kind)
    throw new ToolInputError(
      `patch ${String(id)} is a ${patch.kind} patch, not a ${kind} patch`,
    );
}

function clipLines(text: string, maxLines: number): string {
  return text.trim().split("\n").slice(0, maxLines).join("\n");
}
