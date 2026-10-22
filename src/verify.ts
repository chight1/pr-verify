/**
 * The only path to "verified". The scratch tree is the runner's checkout;
 * every verification starts from a clean reset to the PR commit, applies the
 * patches under test, and runs the project's own suite.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDiff, totalChangedLines, type DiffFile } from './diff.js';
import { git } from './context.js';
import type { Patch, PatchKind } from './types.js';

const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing']);
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /Tests?\.cs$/,
  /Tests?\.java$/,
  /_spec\.rb$/,
  /\.test\.ps1$/,
];

/** Conservative notion of "a test location": a test directory anywhere in the path, or a test-named file. */
export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase()))) return true;
  return TEST_FILE_PATTERNS.some((p) => p.test(base));
}

const DEPENDENCY_FILES = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb?$/,
  /^requirements[^/]*\.txt$/,
  /^pyproject\.toml$/,
  /^setup\.(py|cfg)$/,
  /^poetry\.lock$/,
  /^Pipfile(\.lock)?$/,
  /^uv\.lock$/,
  /^go\.(mod|sum)$/,
  /^Cargo\.(toml|lock)$/,
  /^Gemfile(\.lock)?$/,
  /\.csproj$/,
  /^packages\.lock\.json$/,
  /^pom\.xml$/,
  /^build\.gradle(\.kts)?$/,
];

export function isDependencyFile(filePath: string): boolean {
  const base = path.posix.basename(filePath.replace(/\\/g, '/'));
  return DEPENDENCY_FILES.some((p) => p.test(base));
}

export interface PatchLimits {
  maxLines: number;
  maxFiles: number;
}

export interface PolicyResult {
  ok: boolean;
  violations: string[];
  files: DiffFile[];
}

function isOutsideRepository(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

/**
 * Checks a proposed patch against the policy before anything touches disk.
 * Every rule is listed in the README's guardrails section; keep them in step.
 */
export function checkPatchPolicy(diffText: string, kind: PatchKind, limits: PatchLimits): PolicyResult {
  const files = parseDiff(diffText);
  const violations: string[] = [];

  if (files.length === 0) violations.push('patch contains no file changes');
  if (files.length > limits.maxFiles) {
    violations.push(`patch touches ${files.length} files; the limit is ${limits.maxFiles}`);
  }
  const changed = totalChangedLines(files);
  if (changed > limits.maxLines) {
    violations.push(`patch changes ${changed} lines; the limit is ${limits.maxLines}`);
  }

  for (const file of files) {
    const paths = [file.path, file.oldPath].filter((p): p is string => p !== null);
    for (const p of paths) {
      if (isOutsideRepository(p)) violations.push(`${p}: path resolves outside the repository`);
      if (p === '.github' || p.startsWith('.github/')) violations.push(`${p}: workflow files are off limits`);
      if (isDependencyFile(p)) violations.push(`${p}: dependency manifests and lockfiles are off limits`);
    }
    if (file.binary) violations.push(`${file.path}: binary files are off limits`);
    if (file.symlink) violations.push(`${file.path}: symlinks are off limits`);

    if (kind === 'test') {
      if (!isTestPath(file.path)) {
        violations.push(`${file.path}: a test patch may only touch test locations`);
      } else if (file.status !== 'added' && file.removed > 0) {
        violations.push(`${file.path}: a test patch may only add to an existing test file, not remove lines`);
      }
      if (file.status === 'deleted' || file.status === 'renamed') {
        violations.push(`${file.path}: a test patch may not delete or rename files`);
      }
    }
  }

  if (kind === 'fix' && files.length > 0 && files.every((f) => isTestPath(f.path))) {
    violations.push('a fix patch that touches only tests is not a fix');
  }

  return { ok: violations.length === 0, violations, files };
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/** Runs a shell command, kills it on timeout, and keeps only the last `tailBytes` of combined output. */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  tailBytes: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;

    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command];
    const child = spawn(shell, args, { cwd, env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });

    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      kept += chunk.byteLength;
      while (kept > tailBytes * 2 && chunks.length > 1) {
        kept -= chunks.shift()!.byteLength;
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = Buffer.concat(chunks);
      const output =
        combined.byteLength > tailBytes
          ? `[... ${combined.byteLength - tailBytes} bytes trimmed]\n${combined.subarray(-tailBytes).toString('utf8')}`
          : combined.toString('utf8');
      resolve({ exitCode: timedOut ? null : code, output, durationMs: Date.now() - startedAt, timedOut });
    });
  });
}

export interface ApplyResult {
  applied: boolean;
  error?: string;
}

/**
 * The runner's checkout, treated as disposable. `reset` returns it to the PR
 * commit and removes untracked files (but keeps ignored ones such as
 * node_modules, so a reset does not cost a reinstall).
 */
export class ScratchTree {
  constructor(
    readonly root: string,
    private readonly headSha: string,
    private readonly testCommand: string,
    private readonly testTimeoutMs: number,
    private readonly outputTailBytes = 64 * 1024,
  ) {}

  async reset(): Promise<void> {
    await git(['reset', '-q', '--hard', this.headSha], this.root);
    await git(['clean', '-qfd'], this.root);
  }

  async apply(diff: string): Promise<ApplyResult> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pr-verify-'));
    const file = path.join(dir, 'patch.diff');
    try {
      await writeFile(file, diff.endsWith('\n') ? diff : `${diff}\n`, 'utf8');
      await git(['apply', '--check', '--whitespace=nowarn', file], this.root);
      await git(['apply', '--whitespace=nowarn', file], this.root);
      return { applied: true };
    } catch (error) {
      return { applied: false, error: (error as Error).message };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  runTests(): Promise<CommandResult> {
    return runCommand(this.testCommand, this.root, this.testTimeoutMs, this.outputTailBytes);
  }
}

export interface Verification {
  /** True when the test patch alone makes the suite fail on the PR commit. Null when no test patch. */
  testFails: boolean | null;
  /** True when test plus fix make the suite pass. Null when no fix patch or the test did not fail. */
  fixPasses: boolean | null;
  runs: number;
  durationMs: number;
}

/**
 * Re-runs the agent's demonstration from a clean tree. Only these runs count.
 * A fix is only tried once its test has been shown to fail; a fix for a test
 * that already passes proves nothing.
 */
export async function verifyDemonstration(
  tree: ScratchTree,
  testPatch: Patch | undefined,
  fixPatch: Patch | undefined,
): Promise<Verification> {
  const startedAt = Date.now();
  let runs = 0;
  let testFails: boolean | null = null;
  let fixPasses: boolean | null = null;

  if (testPatch) {
    await tree.reset();
    const applied = await tree.apply(testPatch.diff);
    if (applied.applied) {
      runs += 1;
      const result = await tree.runTests();
      testFails = result.exitCode !== 0;
    } else {
      testFails = false;
    }
  }

  if (fixPatch && testFails === true && testPatch) {
    await tree.reset();
    const testApplied = await tree.apply(testPatch.diff);
    const fixApplied = testApplied.applied ? await tree.apply(fixPatch.diff) : testApplied;
    if (fixApplied.applied) {
      runs += 1;
      const result = await tree.runTests();
      fixPasses = result.exitCode === 0;
    } else {
      fixPasses = false;
    }
  }

  await tree.reset();
  return { testFails, fixPasses, runs, durationMs: Date.now() - startedAt };
}

/** Red-gate mode: a fix is verified when the suite that failed now passes with only the fix applied. */
export async function verifyRedGateFix(tree: ScratchTree, fixPatch: Patch): Promise<Verification> {
  const startedAt = Date.now();
  await tree.reset();
  const applied = await tree.apply(fixPatch.diff);
  let fixPasses = false;
  let runs = 0;
  if (applied.applied) {
    runs = 1;
    const result = await tree.runTests();
    fixPasses = result.exitCode === 0;
  }
  await tree.reset();
  return { testFails: null, fixPasses, runs, durationMs: Date.now() - startedAt };
}
