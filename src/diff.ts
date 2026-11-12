/**
 * A small unified-diff parser for context (what changed), review (is this
 * line commentable), prior findings (did its line change) and the patch
 * policy (what a patch touches).
 * It reads `git diff` output and the diffs the agent proposes, which may be
 * plain unified diffs without git's headers.
 */

/** The file mode git gives a symlink, as in `new file mode 120000`. */
const SYMLINK_MODE = "120000";

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

export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = "/dev/null";

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/** The path in a `--- ` or `+++ ` line, without a/b prefix or a traditional diff's tab-separated timestamp. */
export function headerPath(line: string): string {
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
    if (line.endsWith(SYMLINK_MODE)) file.symlink = true;
    return true;
  }
  if (line.startsWith("deleted file mode")) {
    file.status = "deleted";
    file.path = file.oldPath ?? file.path;
    return true;
  }
  if (!line.startsWith("old mode") && !line.startsWith("new mode"))
    return false;
  if (line.endsWith(SYMLINK_MODE)) file.symlink = true;
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
