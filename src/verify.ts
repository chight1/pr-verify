/**
 * The only path to "verified". The scratch tree is the runner's checkout;
 * every verification starts from a clean reset to the PR commit, applies the
 * patches under test, and runs the project's own suite.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDiff, totalChangedLines, type DiffFile } from "./diff.js";
import { git } from "./context.js";
import type { Sandbox } from "./sandbox.js";
import type { Patch, PatchKind } from "./types.js";

const TEST_DIR_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "testing",
]);
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
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase())))
    return true;
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
  const base = path.posix.basename(filePath.replace(/\\/g, "/"));
  return DEPENDENCY_FILES.some((p) => p.test(base));
}

/** A patch that silences a scanner instead of fixing what it found is not a fix. */
const SCANNER_IGNORE_FILES = new Set([
  ".semgrepignore",
  ".trivyignore",
  ".trivyignore.yaml",
]);

export function isScannerIgnoreFile(filePath: string): boolean {
  return SCANNER_IGNORE_FILES.has(
    path.posix.basename(filePath.replace(/\\/g, "/")),
  );
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
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

/**
 * Checks a proposed patch against the policy before anything touches disk.
 * Every rule is listed in the README's guardrails section; keep them in step.
 */
export function checkPatchPolicy(
  diffText: string,
  kind: PatchKind,
  limits: PatchLimits,
): PolicyResult {
  const files = parseDiff(diffText);
  const violations: string[] = [];

  if (files.length === 0) violations.push("patch contains no file changes");
  if (files.length > limits.maxFiles) {
    violations.push(
      `patch touches ${String(files.length)} files; the limit is ${String(limits.maxFiles)}`,
    );
  }
  const changed = totalChangedLines(files);
  if (changed > limits.maxLines) {
    violations.push(
      `patch changes ${String(changed)} lines; the limit is ${String(limits.maxLines)}`,
    );
  }

  for (const file of files) {
    const paths = [file.path, file.oldPath].filter(
      (p): p is string => p !== null,
    );
    for (const p of paths) {
      if (isOutsideRepository(p))
        violations.push(`${p}: path resolves outside the repository`);
      if (p === ".github" || p.startsWith(".github/"))
        violations.push(`${p}: workflow files are off limits`);
      if (isDependencyFile(p))
        violations.push(
          `${p}: dependency manifests and lockfiles are off limits`,
        );
      if (isScannerIgnoreFile(p))
        violations.push(`${p}: scanner ignore files are off limits`);
    }
    if (file.binary)
      violations.push(`${file.path}: binary files are off limits`);
    if (file.symlink) violations.push(`${file.path}: symlinks are off limits`);

    if (kind === "test") {
      if (!isTestPath(file.path)) {
        violations.push(
          `${file.path}: a test patch may only touch test locations`,
        );
      } else if (file.status !== "added" && file.removed > 0) {
        violations.push(
          `${file.path}: a test patch may only add to an existing test file, not remove lines`,
        );
      }
      if (file.status === "deleted" || file.status === "renamed") {
        violations.push(
          `${file.path}: a test patch may not delete or rename files`,
        );
      }
    }
  }

  if (
    kind === "fix" &&
    files.length > 0 &&
    files.every((f) => isTestPath(f.path))
  ) {
    violations.push("a fix patch that touches only tests is not a fix");
  }

  return { ok: violations.length === 0, violations, files };
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs a shell command, kills it on timeout, and keeps only the last
 * `tailBytes` of combined output. With a sandbox, the command runs inside it.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  tailBytes: number,
  sandbox: Sandbox | null = null,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    let kept = 0;
    let timedOut = false;

    const shell = process.platform === "win32" ? "powershell" : "bash";
    const local = {
      file: shell,
      args:
        process.platform === "win32"
          ? ["-NoProfile", "-Command", command]
          : ["-c", command],
    };
    const { file, args } = sandbox
      ? sandbox.wrap(command, cwd, timeoutMs)
      : local;
    const env = sandbox
      ? { PATH: process.env.PATH }
      : { ...process.env, CI: "true" };
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      kept += chunk.byteLength;
      while (kept > tailBytes * 2 && chunks.length > 1) {
        const oldest = chunks.shift();
        if (!oldest) throw new Error("no output chunk left to drop");
        kept -= oldest.byteLength;
      }
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    // A sandboxed command is killed by the sandbox, since this process cannot signal one started through sudo.
    const timer = sandbox
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (sandbox && code !== 0 && Date.now() - startedAt >= timeoutMs)
        timedOut = true;
      const combined = Buffer.concat(chunks);
      const output =
        combined.byteLength > tailBytes
          ? `[... ${String(combined.byteLength - tailBytes)} bytes trimmed]\n${combined.subarray(-tailBytes).toString("utf8")}`
          : combined.toString("utf8");
      resolve({
        exitCode: timedOut ? null : code,
        output,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

/** A harness run: the build, then the suite. */
export interface TestRun extends CommandResult {
  /** True when the build failed, so the suite never ran. */
  buildFailed: boolean;
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
    private readonly commands: { build: string; test: string },
    private readonly testTimeoutMs: number,
    private readonly sandbox: Sandbox | null = null,
    private readonly outputTailBytes = 64 * 1024,
  ) {}

  async reset(): Promise<void> {
    await git(["reset", "-q", "--hard", this.headSha], this.root);
    await git(["clean", "-qfd"], this.root);
  }

  async apply(diff: string): Promise<ApplyResult> {
    return this.withPatchFile(diff, async (file) => {
      try {
        await git(["apply", "--check", "--whitespace=nowarn", file], this.root);
        await git(["apply", "--whitespace=nowarn", file], this.root);
        return { applied: true };
      } catch (error) {
        return { applied: false, error: (error as Error).message };
      }
    });
  }

  /** True when the tree already contains the patch's changes, i.e. it would apply in reverse. */
  async contains(diff: string): Promise<boolean> {
    return this.withPatchFile(diff, (file) =>
      git(
        ["apply", "--reverse", "--check", "--whitespace=nowarn", file],
        this.root,
      ).then(
        () => true,
        () => false,
      ),
    );
  }

  private async withPatchFile<T>(
    diff: string,
    use: (file: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-verify-"));
    const file = path.join(dir, "patch.diff");
    try {
      await writeFile(file, diff.endsWith("\n") ? diff : `${diff}\n`, "utf8");
      return await use(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Builds, then runs the suite, so a patch to the source is compiled before it is tested. */
  async runTests(): Promise<TestRun> {
    const run = (command: string) =>
      runCommand(
        command,
        this.root,
        this.testTimeoutMs,
        this.outputTailBytes,
        this.sandbox,
      );
    let buildMs = 0;
    if (this.commands.build) {
      const build = await run(this.commands.build);
      if (build.exitCode !== 0) {
        return {
          ...build,
          output: `The build failed, so the suite did not run.\n\n${build.output}`,
          buildFailed: true,
        };
      }
      buildMs = build.durationMs;
    }
    const test = await run(this.commands.test);
    return {
      ...test,
      durationMs: buildMs + test.durationMs,
      buildFailed: false,
    };
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
      // A test that breaks the build demonstrates nothing about the code under test.
      testFails = result.exitCode !== 0 && !result.buildFailed;
    } else {
      testFails = false;
    }
  }

  if (fixPatch && testFails === true && testPatch) {
    await tree.reset();
    const testApplied = await tree.apply(testPatch.diff);
    const fixApplied = testApplied.applied
      ? await tree.apply(fixPatch.diff)
      : testApplied;
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

/** The gate's Semgrep run, which the harness repeats to verify a fix: the pinned image and the gate's arguments. */
export interface StaticAnalysis {
  image: string;
  args: string;
}

export interface StaticAnalysisResult {
  /** Null when Semgrep itself failed, so the run says nothing about the code. */
  findings: number | null;
  output: string;
  durationMs: number;
}

/**
 * Runs Semgrep over the tree as the gate ran it and counts the findings. It
 * runs outside the sandbox, in its own container with only the tree mounted,
 * since it reads the project's code and never executes it.
 */
export async function runStaticAnalysis(
  tree: ScratchTree,
  analysis: StaticAnalysis,
  timeoutMs: number,
): Promise<StaticAnalysisResult> {
  // Semgrep scans only what git tracks, and files a patch added are untracked.
  await git(["add", "--intent-to-add", "."], tree.root);
  const out = await mkdtemp(path.join(os.tmpdir(), "pr-verify-semgrep-"));
  try {
    const command = [
      "docker run --rm",
      `--user ${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      `-e HOME=/tmp -v "${tree.root}:/src" -v "${out}:/out" -w /src`,
      analysis.image,
      "semgrep scan",
      analysis.args,
      "--metrics off --disable-version-check --json --output /out/results.json",
    ].join(" ");
    const result = await runCommand(command, tree.root, timeoutMs, 16 * 1024);
    if (result.exitCode !== 0)
      return {
        findings: null,
        output: result.output,
        durationMs: result.durationMs,
      };
    const report = JSON.parse(
      await readFile(path.join(out, "results.json"), "utf8"),
    ) as { results?: unknown[] };
    return {
      findings: report.results?.length ?? 0,
      output: result.output,
      durationMs: result.durationMs,
    };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/**
 * Red-gate mode at the static analysis step: a fix is verified when Semgrep
 * finds nothing with only the fix applied and the suite still passes.
 * `countFindings` runs Semgrep on the tree as it stands.
 */
export async function verifyStaticAnalysisFix(
  tree: ScratchTree,
  fixPatch: Patch,
  countFindings: () => Promise<number | null>,
): Promise<Verification & { findingsLeft: number | null }> {
  const startedAt = Date.now();
  await tree.reset();
  let findingsLeft: number | null = null;
  let fixPasses = false;
  let runs = 0;
  if ((await tree.apply(fixPatch.diff)).applied) {
    findingsLeft = await countFindings();
    if (findingsLeft === 0) {
      runs = 1;
      fixPasses = (await tree.runTests()).exitCode === 0;
    }
  }
  await tree.reset();
  return {
    testFails: null,
    fixPasses,
    runs,
    findingsLeft,
    durationMs: Date.now() - startedAt,
  };
}

/** passes: the bug is gone. fails: still there. unusable: the test does not fit this commit, so it says nothing. */
export type RecheckResult = "passes" | "fails" | "unusable";

/**
 * Runs an earlier finding's test against the current PR commit. The test is
 * applied, or used as it stands when the author has already committed it.
 * It goes through the same policy as a fresh test patch first, because it was
 * read back from a comment.
 */
export async function recheckDemonstration(
  tree: ScratchTree,
  testDiff: string,
  limits: PatchLimits,
): Promise<{ result: RecheckResult; runs: number; durationMs: number }> {
  const startedAt = Date.now();
  if (!checkPatchPolicy(testDiff, "test", limits).ok)
    return { result: "unusable", runs: 0, durationMs: 0 };

  await tree.reset();
  let result: RecheckResult = "unusable";
  let runs = 0;
  if ((await tree.apply(testDiff)).applied || (await tree.contains(testDiff))) {
    runs = 1;
    const run = await tree.runTests();
    result = run.buildFailed
      ? "unusable"
      : run.exitCode === 0
        ? "passes"
        : "fails";
  }
  await tree.reset();
  return { result, runs, durationMs: Date.now() - startedAt };
}

/** Red-gate mode: a fix is verified when the suite that failed now passes with only the fix applied. */
export async function verifyRedGateFix(
  tree: ScratchTree,
  fixPatch: Patch,
): Promise<Verification> {
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
  return {
    testFails: null,
    fixPasses,
    runs,
    durationMs: Date.now() - startedAt,
  };
}
