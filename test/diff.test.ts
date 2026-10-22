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
