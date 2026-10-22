/**
 * A small unified-diff parser. Three modules depend on it: context (what
 * changed), review (is this line commentable), verify (the patch policy).
 * It reads `git diff` output and the diffs the agent proposes.
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

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '');
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (?:"?)(.+?)(?:"?) (?:"?)(.+?)(?:"?)$/.exec(line);
      const oldPath = match ? stripPrefix(match[1] ?? '') : '';
      const newPath = match ? stripPrefix(match[2] ?? '') : '';
      current = {
        path: newPath,
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
      files.push(current);
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
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('index ')) {
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
      oldLine = h.oldStart;
      newLine = h.newStart;
      continue;
    }
    if (current.hunks.length === 0) continue;

    if (line.startsWith('+')) {
      current.added += 1;
      current.rightLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      current.removed += 1;
      current.leftLines.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith(' ') || line === '') {
      // Context line. A blank line inside a hunk is a context line whose content is empty.
      current.rightLines.add(newLine);
      current.leftLines.add(oldLine);
      newLine += 1;
      oldLine += 1;
    }
    // Lines starting with '\' ("No newline at end of file") fall through untouched.
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
