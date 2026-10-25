import { describe, expect, it } from 'vitest';
import { isCommentable, parseDiff, totalChangedLines } from '../src/diff.js';

const SAMPLE = `diff --git a/src/order.ts b/src/order.ts
index 1111111..2222222 100644
--- a/src/order.ts
+++ b/src/order.ts
@@ -10,6 +10,7 @@ export function total(items: Item[]) {
   let sum = 0;
   for (const item of items) {
-    sum += item.price;
+    sum += item.price * item.quantity;
+    if (item.discount) sum -= item.discount;
   }
   return sum;
 }
diff --git a/test/order.test.ts b/test/order.test.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/test/order.test.ts
@@ -0,0 +1,3 @@
+import { total } from '../src/order';
+
+test('empty', () => expect(total([])).toBe(0));
diff --git a/assets/logo.png b/assets/logo.png
index 4444444..5555555 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 6666666..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-
`;

describe('parseDiff', () => {
  const files = parseDiff(SAMPLE);

  it('finds every file with its status', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/order.ts', 'modified'],
      ['test/order.test.ts', 'added'],
      ['assets/logo.png', 'modified'],
      ['new.ts', 'renamed'],
      ['gone.ts', 'deleted'],
    ]);
  });

  it('counts added and removed lines per file', () => {
    const order = files[0]!;
    expect(order.added).toBe(2);
    expect(order.removed).toBe(1);
    expect(files[1]!.added).toBe(3);
    expect(totalChangedLines(files)).toBe(2 + 1 + 3 + 2);
  });

  it('tracks new-side line numbers through a hunk', () => {
    const order = files[0]!;
    // New side: context 10,11; added 12,13; context 14,15,16. Old side: 10..15 with 12 removed.
    expect([...order.rightLines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect([...order.leftLines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('flags binary files and records renames', () => {
    expect(files[2]!.binary).toBe(true);
    expect(files[3]!.oldPath).toBe('old.ts');
    expect(files[4]!.oldPath).toBe('gone.ts');
  });

  it('detects symlinks by mode', () => {
    const link = parseDiff(`diff --git a/link b/link\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../etc/passwd\n`);
    expect(link[0]!.symlink).toBe(true);
  });
});

describe('parseDiff without git headers', () => {
  it('reads plain unified diffs, including added and deleted files and traditional timestamps', () => {
    const files = parseDiff(
      [
        '--- a/src/order.ts',
        '+++ b/src/order.ts',
        '@@ -12,1 +12,1 @@',
        '-    sum += item.price;',
        '+    sum += item.price * item.quantity;',
        '--- /dev/null',
        '+++ b/test/order.test.ts',
        '@@ -0,0 +1,1 @@',
        "+test('x', () => {});",
        '--- a/gone.ts\t2026-10-25 10:00:00',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-export const gone = true;',
        '',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.added, f.removed])).toEqual([
      ['src/order.ts', 'src/order.ts', 'modified', 1, 1],
      ['test/order.test.ts', null, 'added', 1, 0],
      ['gone.ts', 'gone.ts', 'deleted', 0, 1],
    ]);
  });
});

describe('hunk bodies', () => {
  it('counts changed lines whose content looks like a file header', () => {
    // A removed SQL comment "-- note" and an added "++ note" read as "--- note" and "+++ note".
    const [file] = parseDiff(
      ['diff --git a/q.sql b/q.sql', 'index 1..2 100644', '--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,2 @@', '--- note', '+++ note', ' select 1;', ''].join('\n'),
    );
    expect(file).toMatchObject({ path: 'q.sql', added: 1, removed: 1 });
    expect([...file!.rightLines]).toEqual([1, 2]);
    expect([...file!.leftLines]).toEqual([1, 2]);
  });

  it('ends a hunk that overstates its counts at the next file instead of swallowing it', () => {
    const files = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,1 +1,9 @@',
        '-a',
        '+b',
        'diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml',
        '--- a/.github/workflows/x.yml',
        '+++ b/.github/workflows/x.yml',
        '@@ -1,1 +1,1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['a.ts', 1, 1],
      ['.github/workflows/x.yml', 1, 1],
    ]);
  });
});

describe('isCommentable', () => {
  const files = parseDiff(SAMPLE);

  it('accepts lines inside a hunk on the new side', () => {
    expect(isCommentable(files, 'src/order.ts', 13)).toBe(true);
    expect(isCommentable(files, 'src/order.ts', 10)).toBe(true);
  });

  it('rejects lines outside every hunk, binary files, deleted files and unknown paths', () => {
    expect(isCommentable(files, 'src/order.ts', 3)).toBe(false);
    expect(isCommentable(files, 'assets/logo.png', 1)).toBe(false);
    expect(isCommentable(files, 'gone.ts', 1)).toBe(false);
    expect(isCommentable(files, 'nope.ts', 1)).toBe(false);
  });
});
