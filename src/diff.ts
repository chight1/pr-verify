/**
 * A small unified-diff parser. Three modules depend on it: context (what
 * changed), review (is this line commentable), verify (the patch policy).
 * It reads `git diff` output and the diffs the agent proposes, which may be
 * plain unified diffs without git's headers.
 */

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  /** Path on the new side; for a deletion, the old path. */
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  symlink: boolean;
  added: number;
  removed: number;
  hunks: Hunk[];
  /** New-side line numbers that appear in a hunk (added or context). Commentable on GitHub. */
  rightLines: Set<number>;
  /** Old-side line numbers that appear in a hunk. Used to decide whether a prior finding's line changed. */
  leftLines: Set<number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = "/dev/null";

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/** The path in a `--- ` or `+++ ` line, without a/b prefix or a traditional diff's tab-separated timestamp. */
function headerPath(line: string): string {
  const raw = line.slice(4).split("\t")[0] ?? "";
  return raw === DEV_NULL
    ? DEV_NULL
    : stripPrefix(raw.replace(/^"(.*)"$/, "$1"));
}

function emptyFile(path: string, oldPath: string | null): DiffFile {
  return {
    path,
    oldPath,
    status: "modified",
    binary: false,
    symlink: false,
    added: 0,
    removed: 0,
    hunks: [],
    rightLines: new Set(),
    leftLines: new Set(),
  };
}

/**
 * Parses `git diff` output and plain unified diffs (files introduced by
 * `--- `/`+++ ` with no `diff --git` line), since `git apply` accepts both and
 * the agent writes either.
 *
 * Hunk bodies are read by the counts in their `@@` header, the same way git
 * reads them. That is what lets a removed line whose content starts with
 * "-- " be told apart from a file header. A body line that cannot be part of
 * a hunk ends it early, so a header that overstates its counts cannot swallow
 * the next file and hide it from the patch policy.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  /** True between a `diff --git` line and that file's first hunk, while its `---`/`+++` lines belong to it. */
  let gitHeaderOpen = false;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (current && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = line[0];
      if (marker === "+" && newRemaining > 0) {
        current.added += 1;
        current.rightLines.add(newLine);
        newLine += 1;
        newRemaining -= 1;
        continue;
      }
      if (marker === "-" && oldRemaining > 0) {
        current.removed += 1;
        current.leftLines.add(oldLine);
        oldLine += 1;
        oldRemaining -= 1;
        continue;
      }
      if (
        (marker === " " || line === "") &&
        oldRemaining > 0 &&
        newRemaining > 0
      ) {
        // A blank line inside a hunk is a context line whose trailing space was stripped.
        current.rightLines.add(newLine);
        current.leftLines.add(oldLine);
        newLine += 1;
        oldLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
      if (marker === "\\") continue; // "\ No newline at end of file"
      // Not a line this hunk can hold: the header overstated its counts. End it here.
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (line.startsWith("\\")) continue;

    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?)(.+?)(?:"?) (?:"?)(.+?)(?:"?)$/.exec(
        line,
      );
      current = emptyFile(
        match ? stripPrefix(match[2] ?? "") : "",
        match ? stripPrefix(match[1] ?? "") : "",
      );
      files.push(current);
      gitHeaderOpen = true;
      continue;
    }

    if (line.startsWith("--- ")) {
      if (gitHeaderOpen) continue; // git's own header lines repeat what `diff --git` and the mode lines said
      const oldPath = headerPath(line);
      current = emptyFile(oldPath, oldPath === DEV_NULL ? null : oldPath);
      if (oldPath === DEV_NULL) current.status = "added";
      files.push(current);
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (gitHeaderOpen || !current) continue;
      const newPath = headerPath(line);
      if (newPath === DEV_NULL) {
        current.status = "deleted";
      } else {
        current.path = newPath;
      }
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      current.oldPath = null;
      if (line.endsWith("120000")) current.symlink = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      current.path = current.oldPath ?? current.path;
      continue;
    }
    if (line.startsWith("old mode") || line.startsWith("new mode")) {
      if (line.endsWith("120000")) current.symlink = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      continue;
    }
    if (
      line.startsWith("Binary files") ||
      line.startsWith("GIT binary patch")
    ) {
      current.binary = true;
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      const h: Hunk = {
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
      };
      current.hunks.push(h);
      gitHeaderOpen = false;
      oldLine = h.oldStart;
      newLine = h.newStart;
      oldRemaining = h.oldLines;
      newRemaining = h.newLines;
    }
  }

  return files;
}

/** True when the line at `i` starts the next file of a plain unified diff: `--- `, then `+++ `, then a hunk header. */
function startsPlainFile(lines: string[], i: number): boolean {
  return (
    (lines[i] ?? "").startsWith("--- ") &&
    (lines[i + 1] ?? "").startsWith("+++ ") &&
    HUNK_HEADER.test(lines[i + 2] ?? "")
  );
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

    const body: string[] = [];
    let j = i + 1;
    for (const line of lines.slice(j)) {
      if (HUNK_HEADER.test(line) || line.startsWith("diff --git ")) break;
      if (plain && startsPlainFile(lines, j)) break;
      const marker = line[0];
      if (
        line !== "" &&
        marker !== " " &&
        marker !== "+" &&
        marker !== "-" &&
        marker !== "\\"
      )
        break;
      body.push(line);
      j += 1;
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();

    let oldCount = 0;
    let newCount = 0;
    for (const line of body) {
      if (line.startsWith("+")) newCount += 1;
      else if (line.startsWith("-")) oldCount += 1;
      else if (line.startsWith("\\")) continue;
      else {
        oldCount += 1;
        newCount += 1;
      }
    }

    const [, oldStart, , newStart] = header;
    if (oldStart === undefined || newStart === undefined)
      throw new Error(
        `hunk header matched without its start lines: ${current}`,
      );
    const rest = current.slice(header[0].length);
    out.push(
      `@@ -${oldStart},${String(oldCount)} +${newStart},${String(newCount)} @@${rest}`,
      ...body,
    );
    resume = j;
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
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
    let remaining = Number(header[2] ?? 1) + Number(header[4] ?? 1);
    let leading = 0;
    let trailing = 0;
    let changed = false;
    for (const body of lines.slice(i + 1)) {
      if (remaining <= 0) break;
      if (body.startsWith("\\")) continue;
      if (body.startsWith("+") || body.startsWith("-")) {
        changed = true;
        trailing = 0;
        remaining -= 1;
      } else {
        if (changed) trailing += 1;
        else leading += 1;
        remaining -= 2;
      }
    }
    if (changed && leading > 0 && trailing === 0) {
      hints.push(
        `${path}: the hunk at old line ${String(oldStart)} has ${String(leading)} context line(s) before its change and none after. ` +
          "git applies a hunk like that only at the end of a file. Add the lines that follow the change as context.",
      );
    }
  }
  return hints;
}

/** True when `line` of `path` on the PR head is a line GitHub will accept an inline comment on. */
export function isCommentable(
  files: DiffFile[],
  path: string,
  line: number,
): boolean {
  const file = files.find((f) => f.path === path && f.status !== "deleted");
  return file !== undefined && !file.binary && file.rightLines.has(line);
}

export function totalChangedLines(files: DiffFile[]): number {
  return files.reduce((sum, f) => sum + f.added + f.removed, 0);
}
