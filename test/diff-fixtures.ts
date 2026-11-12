/** A git diff the diff and patch-repair tests share: a modified, an added, a binary, a renamed and a deleted file. */

export const SAMPLE = `diff --git a/src/order.ts b/src/order.ts
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
