/**
 * Repairs for the patches Claude writes: recounting the hunk headers it gets
 * wrong, and hints for a patch `git apply` still rejects.
 */

import { HUNK_HEADER, headerPath } from "./diff.js";

const PLAIN_FILE_HEADER_LINES = 3;
/** A context line counts toward both the old and the new side of a hunk. */
const SIDES_PER_CONTEXT_LINE = 2;

/** True when the line at `i` starts the next file of a plain unified diff: `--- `, then `+++ `, then a hunk header. */
function startsPlainFile(lines: string[], i: number): boolean {
  const [oldHeader = "", newHeader = "", hunkHeader = ""] = lines.slice(
    i,
    i + PLAIN_FILE_HEADER_LINES,
  );
  return (
    oldHeader.startsWith("--- ") &&
    newHeader.startsWith("+++ ") &&
    HUNK_HEADER.test(hunkHeader)
  );
}

/** How a hunk body line can start: context, added, removed, or a `\` note. */
const BODY_MARKERS = new Set([" ", "+", "-", "\\"]);

/** True when the line at `j` cannot belong to the body of the hunk above it. */
function endsHunkBody(
  lines: string[],
  j: number,
  line: string,
  plain: boolean,
): boolean {
  if (HUNK_HEADER.test(line) || line.startsWith("diff --git ")) return true;
  if (plain && startsPlainFile(lines, j)) return true;
  return line !== "" && !BODY_MARKERS.has(line.charAt(0));
}

/** The lines from `start` on that belong to the body of the hunk whose header is just above, trailing blanks included. */
function hunkBody(lines: string[], start: number, plain: boolean): string[] {
  const end = lines.findIndex(
    (line, j) => j >= start && endsHunkBody(lines, j, line, plain),
  );
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** A hunk body's line count on one side: every line but the other side's changes and `\` notes. */
function sideCount(body: string[], other: "+" | "-"): number {
  return body.filter((l) => !l.startsWith(other) && !l.startsWith("\\")).length;
}

/** The matched hunk header, with the counts of `body`. */
function recountedHeader(header: RegExpExecArray, body: string[]): string {
  const [, oldStart, , newStart] = header;
  if (oldStart === undefined || newStart === undefined)
    throw new Error(
      `hunk header matched without its start lines: ${header.input}`,
    );
  const rest = header.input.slice(header[0].length);
  return `@@ -${oldStart},${String(sideCount(body, "+"))} +${newStart},${String(sideCount(body, "-"))} @@${rest}`;
}

/**
 * Rewrites every hunk header's line counts from the lines that follow it.
 *
 * The agent writes diffs by hand and routinely gets the counts in `@@` headers
 * wrong, and `git apply` rejects any patch whose counts do not match its body.
 * Recounting before the policy check and the apply means both read the same
 * hunks, and the patch posted in a comment is the one that was verified.
 *
 * A hunk's body runs until a line that cannot belong to a hunk: another hunk
 * header, a `diff --git` line, or, in a diff without git headers, a
 * `---`/`+++`/`@@` triple. Blank lines at the end of a body are dropped rather
 * than counted as context, because a model that strips trailing spaces leaves
 * them indistinguishable from the gap between files.
 */
export function recountHunks(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const plain = !lines.some((l) => l.startsWith("diff --git "));
  const out: string[] = [];

  // Lines before `resume` were taken into the previous hunk's body.
  let resume = 0;
  for (const [i, current] of lines.entries()) {
    if (i < resume) continue;
    const header = HUNK_HEADER.exec(current);
    if (!header) {
      out.push(current);
      continue;
    }
    const body = hunkBody(lines, i + 1, plain);
    resume = i + 1 + body.length;
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    out.push(recountedHeader(header, body), ...body);
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

/**
 * How many context lines come before a hunk's change when none come after it,
 * reading the lines after its header until they cover `sides`, its old and new
 * counts together. Zero for any other hunk.
 */
function contextOnlyBefore(lines: string[], sides: number): number {
  let remaining = sides;
  let leading = 0;
  let trailing = 0;
  let changed = false;
  for (const body of lines) {
    if (remaining <= 0) break;
    if (body.startsWith("\\")) continue;
    if (body.startsWith("+") || body.startsWith("-")) {
      changed = true;
      trailing = 0;
      remaining -= 1;
    } else {
      if (changed) trailing += 1;
      else leading += 1;
      remaining -= SIDES_PER_CONTEXT_LINE;
    }
  }
  return changed && trailing === 0 ? leading : 0;
}

/**
 * Hints for a patch that `git apply` rejected, for mistakes git's own message
 * does not explain. Takes a recounted patch, so counts can be trusted.
 *
 * The one case so far: a hunk with context before its change and none after.
 * `git diff` only writes such a hunk at the end of a file, so git will only
 * apply it there, and reports a plain "patch does not apply" anywhere else.
 */
export function applyHints(recounted: string): string[] {
  const hints: string[] = [];
  let path = "";
  const lines = recounted.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.startsWith("+++ ")) {
      path = headerPath(line);
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (!header) continue;

    const oldStart = Number(header[1]);
    const sides = Number(header[2] ?? 1) + Number(header[4] ?? 1);
    const leading = contextOnlyBefore(lines.slice(i + 1), sides);
    if (leading > 0) {
      hints.push(
        `${path}: the hunk at old line ${String(oldStart)} has ${String(leading)} context line(s) before its change and none after. ` +
          "git applies a hunk like that only at the end of a file. Add the lines that follow the change as context.",
      );
    }
  }
  return hints;
}
