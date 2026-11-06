/**
 * A small unified-diff parser for context (what changed), review (is this
 * line commentable), prior findings (did its line change) and the patch
 * policy (what a patch touches).
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
const PLAIN_FILE_HEADER_LINES = 3;
/** A context line counts toward both the old and the new side of a hunk. */
const SIDES_PER_CONTEXT_LINE = 2;

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/** The path in a `--- ` or `+++ ` line, without a/b prefix or a traditional diff's tab-separated timestamp. */
function headerPath(line: string): string {
  const raw = line.slice("--- ".length).split("\t")[0] ?? "";
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

/** Applies a git header line about the file's mode to it. False for any other line. */
function readModeHeader(file: DiffFile, line: string): boolean {
  if (line.startsWith("new file mode")) {
    file.status = "added";
    file.oldPath = null;
    if (line.endsWith("120000")) file.symlink = true;
    return true;
  }
  if (line.startsWith("deleted file mode")) {
    file.status = "deleted";
    file.path = file.oldPath ?? file.path;
    return true;
  }
  if (!line.startsWith("old mode") && !line.startsWith("new mode"))
    return false;
  if (line.endsWith("120000")) file.symlink = true;
  return true;
}

/** Applies a git header line about a rename or binary content to the file. False for any other line. */
function readRenameOrBinaryHeader(file: DiffFile, line: string): boolean {
  if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.oldPath = line.slice("rename from ".length);
    return true;
  }
  if (line.startsWith("rename to ")) {
    file.path = line.slice("rename to ".length);
    return true;
  }
  if (!line.startsWith("Binary files") && !line.startsWith("GIT binary patch"))
    return false;
  file.binary = true;
  return true;
}

/** Reads a diff line by line: the files so far, and how much of the open hunk's body is left. */
class DiffParser {
  readonly files: DiffFile[] = [];
  private current: DiffFile | null = null;
  /** True between a `diff --git` line and that file's first hunk, while its `---`/`+++` lines belong to it. */
  private gitHeaderOpen = false;
  private oldLine = 0;
  private newLine = 0;
  private oldRemaining = 0;
  private newRemaining = 0;

  read(line: string): void {
    if (this.readHunkBody(line) || line.startsWith("\\")) return;
    if (line.startsWith("diff --git ")) this.startGitFile(line);
    else if (line.startsWith("--- ")) this.readOldHeader(line);
    else if (line.startsWith("+++ ")) this.readNewHeader(line);
    else if (this.current) this.readFileLine(this.current, line);
  }

  /** A line of a file's header after its paths, or a hunk header. */
  private readFileLine(file: DiffFile, line: string): void {
    if (readModeHeader(file, line) || readRenameOrBinaryHeader(file, line))
      return;
    this.readHunkHeader(file, line);
  }

  /** Takes the line into the open hunk's body. False when no hunk is open or the line ends it. */
  private readHunkBody(line: string): boolean {
    if (this.current && (this.oldRemaining > 0 || this.newRemaining > 0)) {
      if (this.readBodyLine(this.current, line)) return true;
      // Not a line this hunk can hold: the header overstated its counts. End it here.
      this.oldRemaining = 0;
      this.newRemaining = 0;
    }
    return false;
  }

  private readBodyLine(file: DiffFile, line: string): boolean {
    const marker = line[0];
    if (marker === "+" && this.newRemaining > 0) {
      file.added += 1;
      file.rightLines.add(this.newLine);
      this.newLine += 1;
      this.newRemaining -= 1;
      return true;
    }
    if (marker === "-" && this.oldRemaining > 0) {
      file.removed += 1;
      file.leftLines.add(this.oldLine);
      this.oldLine += 1;
      this.oldRemaining -= 1;
      return true;
    }
    if (
      (marker === " " || line === "") &&
      this.oldRemaining > 0 &&
      this.newRemaining > 0
    ) {
      // A blank line inside a hunk is a context line whose trailing space was stripped.
      file.rightLines.add(this.newLine);
      file.leftLines.add(this.oldLine);
      this.newLine += 1;
      this.oldLine += 1;
      this.oldRemaining -= 1;
      this.newRemaining -= 1;
      return true;
    }
    return marker === "\\"; // "\ No newline at end of file"
  }

  private startGitFile(line: string): void {
    const match = /^diff --git "?(.[^ \n\r\u2028\u2029]*?)"? "?(.+?)"?$/.exec(
      line,
    );
    this.current = emptyFile(
      match ? stripPrefix(match[2] ?? "") : "",
      match ? stripPrefix(match[1] ?? "") : "",
    );
    this.files.push(this.current);
    this.gitHeaderOpen = true;
  }

  /** Outside git's header, a `--- ` line starts a file of a plain unified diff. */
  private readOldHeader(line: string): void {
    if (this.gitHeaderOpen) return; // git's own header lines repeat what `diff --git` and the mode lines said
    const oldPath = headerPath(line);
    this.current = emptyFile(oldPath, oldPath === DEV_NULL ? null : oldPath);
    if (oldPath === DEV_NULL) this.current.status = "added";
    this.files.push(this.current);
  }

  private readNewHeader(line: string): void {
    if (this.gitHeaderOpen || !this.current) return;
    const newPath = headerPath(line);
    if (newPath === DEV_NULL) this.current.status = "deleted";
    else this.current.path = newPath;
  }

  private readHunkHeader(file: DiffFile, line: string): void {
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) return;
    const h: Hunk = {
      oldStart: Number(hunk[1]),
      oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
      newStart: Number(hunk[3]),
      newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
    };
    file.hunks.push(h);
    this.gitHeaderOpen = false;
    this.oldLine = h.oldStart;
    this.newLine = h.newStart;
    this.oldRemaining = h.oldLines;
    this.newRemaining = h.newLines;
  }
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
  const parser = new DiffParser();
  for (const rawLine of text.split("\n")) {
    parser.read(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
  }
  return parser.files;
}

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
