/**
 * A small unified-diff parser. Three modules depend on it: context (what
 * changed), review (is this line commentable), verify (the patch policy).
 * It reads `git diff` output and the diffs the agent proposes, which may be
 * plain unified diffs without git's headers.
 */

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  /** Path on the new side; for a deletion, the old path. */
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
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
const DEV_NULL = '/dev/null';

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

/** The path in a `--- ` or `+++ ` line, without a/b prefix or a traditional diff's tab-separated timestamp. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0] ?? '';
  return raw === DEV_NULL ? DEV_NULL : stripPrefix(raw.replace(/^"(.*)"$/, '$1'));
}

function emptyFile(path: string, oldPath: string | null): DiffFile {
  return {
    path,
    oldPath,
    status: 'modified',
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

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (current && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = line[0];
      if (marker === '+' && newRemaining > 0) {
        current.added += 1;
        current.rightLines.add(newLine);
        newLine += 1;
        newRemaining -= 1;
        continue;
      }
      if (marker === '-' && oldRemaining > 0) {
        current.removed += 1;
        current.leftLines.add(oldLine);
        oldLine += 1;
        oldRemaining -= 1;
        continue;
      }
      if ((marker === ' ' || line === '') && oldRemaining > 0 && newRemaining > 0) {
        // A blank line inside a hunk is a context line whose trailing space was stripped.
        current.rightLines.add(newLine);
        current.leftLines.add(oldLine);
        newLine += 1;
        oldLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
      if (marker === '\\') continue; // "\ No newline at end of file"
      // Not a line this hunk can hold: the header overstated its counts. End it here.
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (line.startsWith('\\')) continue;

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (?:"?)(.+?)(?:"?) (?:"?)(.+?)(?:"?)$/.exec(line);
      current = emptyFile(match ? stripPrefix(match[2] ?? '') : '', match ? stripPrefix(match[1] ?? '') : '');
      files.push(current);
      gitHeaderOpen = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      if (gitHeaderOpen) continue; // git's own header lines repeat what `diff --git` and the mode lines said
      const oldPath = headerPath(line);
      current = emptyFile(oldPath, oldPath === DEV_NULL ? null : oldPath);
      if (oldPath === DEV_NULL) current.status = 'added';
      files.push(current);
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (gitHeaderOpen || !current) continue;
      const newPath = headerPath(line);
      if (newPath === DEV_NULL) {
        current.status = 'deleted';
      } else {
        current.path = newPath;
      }
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      current.oldPath = null;
      if (line.endsWith('120000')) current.symlink = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      current.path = current.oldPath ?? current.path;
      continue;
    }
    if (line.startsWith('old mode') || line.startsWith('new mode')) {
      if (line.endsWith('120000')) current.symlink = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
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

/** True when `line` of `path` on the PR head is a line GitHub will accept an inline comment on. */
export function isCommentable(files: DiffFile[], path: string, line: number): boolean {
  const file = files.find((f) => f.path === path && f.status !== 'deleted');
  return file !== undefined && !file.binary && file.rightLines.has(line);
}

export function totalChangedLines(files: DiffFile[]): number {
  return files.reduce((sum, f) => sum + f.added + f.removed, 0);
}
