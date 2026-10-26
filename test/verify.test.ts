import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPatchPolicy, isDependencyFile, isTestPath, recheckDemonstration, ScratchTree } from '../src/verify.js';

const LIMITS = { maxLines: 200, maxFiles: 6 };

function patch(path: string, body: string, opts: { newFile?: boolean; oldPath?: string } = {}): string {
  const header = opts.newFile
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n`
    : `diff --git a/${opts.oldPath ?? path} b/${path}\nindex 1111111..2222222 100644\n--- a/${opts.oldPath ?? path}\n+++ b/${path}\n`;
  return header + body;
}

const ADD_TEST = patch('test/order.test.ts', `@@ -0,0 +1,2 @@\n+import { total } from '../src/order';\n+test('x', () => expect(total([])).toBe(0));\n`, { newFile: true });
const EXTEND_TEST = patch('test/order.test.ts', `@@ -3,2 +3,3 @@\n test('a', () => {});\n+test('b', () => {});\n test('c', () => {});\n`);
const EDIT_TEST = patch('test/order.test.ts', `@@ -3,2 +3,2 @@\n-test('a', () => {});\n+test('a2', () => {});\n test('c', () => {});\n`);
const FIX_SRC = patch('src/order.ts', `@@ -12,1 +12,1 @@\n-    sum += item.price;\n+    sum += item.price * item.quantity;\n`);

describe('isTestPath', () => {
  it('recognises test directories and test-named files across ecosystems', () => {
    for (const p of ['test/a.ts', 'src/__tests__/a.js', 'pkg/spec/a_spec.rb', 'a.test.tsx', 'b.spec.mjs', 'c_test.go', 'test_d.py', 'e_test.py', 'FooTests.cs']) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it('does not match production code or look-alikes', () => {
    for (const p of ['src/order.ts', 'src/testing-utils/contest.ts', 'latest.ts', 'protest.go', 'src/attestation.py']) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe('isDependencyFile', () => {
  it('matches manifests and lockfiles anywhere in the tree', () => {
    for (const p of ['package.json', 'packages/a/package-lock.json', 'go.mod', 'requirements-dev.txt', 'pyproject.toml', 'Cargo.lock', 'Api.csproj']) {
      expect(isDependencyFile(p), p).toBe(true);
    }
    expect(isDependencyFile('src/package.ts')).toBe(false);
  });
});

describe('checkPatchPolicy', () => {
  it('accepts a new test file as a test patch', () => {
    expect(checkPatchPolicy(ADD_TEST, 'test', LIMITS)).toMatchObject({ ok: true, violations: [] });
  });

  it('accepts a plain unified diff without git headers', () => {
    const plain = "--- /dev/null\n+++ b/test/order.test.ts\n@@ -0,0 +1,1 @@\n+test('x', () => {});\n";
    expect(checkPatchPolicy(plain, 'test', LIMITS)).toMatchObject({ ok: true, violations: [] });
  });

  it('accepts additions to an existing test file but not edits', () => {
    expect(checkPatchPolicy(EXTEND_TEST, 'test', LIMITS).ok).toBe(true);
    const edit = checkPatchPolicy(EDIT_TEST, 'test', LIMITS);
    expect(edit.ok).toBe(false);
    expect(edit.violations[0]).toMatch(/only add to an existing test file/);
  });

  it('rejects a test patch that touches production code', () => {
    const result = checkPatchPolicy(FIX_SRC, 'test', LIMITS);
    expect(result.violations).toContain('src/order.ts: a test patch may only touch test locations');
  });

  it('accepts a fix in production code and rejects a fix that only touches tests', () => {
    expect(checkPatchPolicy(FIX_SRC, 'fix', LIMITS).ok).toBe(true);
    expect(checkPatchPolicy(ADD_TEST, 'fix', LIMITS).violations).toContain('a fix patch that touches only tests is not a fix');
  });

  it('rejects workflow files, dependency files, binaries, symlinks and paths outside the repo', () => {
    const workflow = patch('.github/workflows/ci.yml', `@@ -1,1 +1,1 @@\n-a\n+b\n`);
    expect(checkPatchPolicy(workflow, 'fix', LIMITS).violations[0]).toMatch(/workflow files are off limits/);

    const lock = patch('package-lock.json', `@@ -1,1 +1,1 @@\n-a\n+b\n`);
    expect(checkPatchPolicy(lock, 'fix', LIMITS).violations[0]).toMatch(/dependency manifests/);

    const binary = `diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n`;
    expect(checkPatchPolicy(binary, 'fix', LIMITS).violations[0]).toMatch(/binary/);

    const symlink = `diff --git a/src/link b/src/link\nnew file mode 120000\nindex 0..1\n--- /dev/null\n+++ b/src/link\n@@ -0,0 +1 @@\n+/etc/passwd\n`;
    expect(checkPatchPolicy(symlink, 'fix', LIMITS).violations[0]).toMatch(/symlinks/);

    const outside = patch('../outside.ts', `@@ -1,1 +1,1 @@\n-a\n+b\n`);
    expect(checkPatchPolicy(outside, 'fix', LIMITS).violations[0]).toMatch(/outside the repository/);
  });

  it('enforces the size limits', () => {
    const big = patch('src/a.ts', `@@ -1,0 +1,3 @@\n+a\n+b\n+c\n`);
    const result = checkPatchPolicy(big, 'fix', { maxLines: 2, maxFiles: 6 });
    expect(result.violations).toContain('patch changes 3 lines; the limit is 2');

    const many = ['a', 'b', 'c'].map((n) => patch(`src/${n}.ts`, `@@ -1,1 +1,1 @@\n-x\n+y\n`)).join('');
    expect(checkPatchPolicy(many, 'fix', { maxLines: 200, maxFiles: 2 }).violations).toContain('patch touches 3 files; the limit is 2');
  });

  it('rejects an empty patch', () => {
    expect(checkPatchPolicy('', 'fix', LIMITS).violations).toContain('patch contains no file changes');
  });
});

describe('recheckDemonstration', () => {
  // A one-file project whose suite runs every file under tests/; a test fails by throwing.
  const RUNNER = "for (const f of require('fs').readdirSync('tests')) require('./tests/' + f);\n";
  const TEST = "if (require('../value.js') !== 2) throw new Error('value should be 2');\n";
  const TEST_PATCH = `diff --git a/tests/value.test.js b/tests/value.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/tests/value.test.js\n@@ -0,0 +1,1 @@\n+${TEST}`;

  function repoAt(value: number, extra: Record<string, string> = {}): ScratchTree {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pr-verify-recheck-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    mkdirSync(path.join(dir, 'tests'));
    const files: Record<string, string> = { 'run.js': RUNNER, 'value.js': `module.exports = ${value};\n`, 'tests/keep.test.js': '\n', ...extra };
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'head');
    return new ScratchTree(dir, git('rev-parse', 'HEAD'), 'node run.js', 30_000);
  }

  it('passes once the bug is fixed, wherever the fix landed', async () => {
    expect(await recheckDemonstration(repoAt(2), TEST_PATCH, LIMITS)).toMatchObject({ result: 'passes', runs: 1 });
  });

  it('fails while the bug is still there', async () => {
    expect(await recheckDemonstration(repoAt(1), TEST_PATCH, LIMITS)).toMatchObject({ result: 'fails', runs: 1 });
  });

  it('uses the test as it stands when the author committed it', async () => {
    const tree = repoAt(2, { 'tests/value.test.js': TEST });
    expect(await recheckDemonstration(tree, TEST_PATCH, LIMITS)).toMatchObject({ result: 'passes', runs: 1 });
  });

  it('is unusable when the test no longer fits the tree, and leaves the tree clean', async () => {
    const tree = repoAt(2, { 'tests/value.test.js': 'something else\n' });
    expect(await recheckDemonstration(tree, TEST_PATCH, LIMITS)).toMatchObject({ result: 'unusable', runs: 0 });
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: tree.root }).toString()).toBe('');
  });

  it('never runs a patch read back from a comment that breaks the test-patch policy', async () => {
    const tree = repoAt(1);
    expect(await recheckDemonstration(tree, FIX_SRC, LIMITS)).toEqual({ result: 'unusable', runs: 0, durationMs: 0 });
  });
});
