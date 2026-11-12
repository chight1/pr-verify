/**
 * Fixtures the patch-policy, test-checkout and proof tests share: a patch
 * builder and the policy limits, and a one-file temporary repository whose
 * suite passes when value.js exports 2.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestCheckout } from "../src/test-checkout.js";

export const LIMITS = { maxLines: 200, maxFiles: 6 };

export function patch(
  path: string,
  body: string,
  opts: { newFile?: boolean; oldPath?: string } = {},
): string {
  const header = opts.newFile
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${opts.oldPath ?? path} b/${path}\nindex 1111111..2222222 100644\n--- a/${opts.oldPath ?? path}\n+++ b/${path}\n`;
  return header + body;
}

export const FIX_SRC = patch(
  "src/order.ts",
  `@@ -12,1 +12,1 @@\n-    sum += item.price;\n+    sum += item.price * item.quantity;\n`,
);

// A one-file project for the harness runs whose suite runs every file under tests/; a test fails by throwing.
const RUNNER =
  "for (const f of require('fs').readdirSync('tests')) require('./tests/' + f);\n";
export const TEST =
  "if (require('../value.js') !== 2) throw new Error('value should be 2');\n";
export const TEST_PATCH = `diff --git a/tests/value.test.js b/tests/value.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/value.test.js\n@@ -0,0 +1,1 @@\n+${TEST}`;

export function repoAt(
  value: number,
  extra: Record<string, string> = {},
  build = "",
): TestCheckout {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-verify-recheck-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
  mkdirSync(path.join(dir, "tests"));
  const files: Record<string, string> = {
    "run.js": RUNNER,
    "value.js": `module.exports = ${String(value)};\n`,
    "tests/keep.test.js": "\n",
    ...extra,
  };
  for (const [file, text] of Object.entries(files))
    writeFileSync(path.join(dir, file), text);
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "head",
  );
  return new TestCheckout(
    dir,
    git("rev-parse", "HEAD"),
    { build, test: "node run.js" },
    30_000,
  );
}
