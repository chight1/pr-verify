/**
 * The scratch tree: the runner's checkout, treated as disposable. Every
 * harness run starts from a reset to the PR commit, applies the patches under
 * test, and runs the project's own build and suite, in the sandbox when there
 * is one.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "./context.js";
import type { Sandbox } from "./sandbox.js";

/** Output held in memory before the oldest chunks are dropped, as a multiple of the tail returned. */
const OUTPUT_BUFFER_TAILS = 2;
/** How much of a harness run's output, from the end, is kept. */
const TEST_OUTPUT_TAIL_BYTES = 64 * 1024;

export interface CommandResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/** The program, arguments and environment a command runs with: the platform's shell, or the sandbox that wraps it. */
function invocation(
  command: string,
  cwd: string,
  timeoutMs: number,
  sandbox: Sandbox | null,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (sandbox)
    return {
      ...sandbox.wrap(command, cwd, timeoutMs),
      env: { PATH: process.env.PATH },
    };
  const windows = process.platform === "win32";
  return {
    file: windows ? "powershell" : "bash",
    args: windows ? ["-NoProfile", "-Command", command] : ["-c", command],
    env: { ...process.env, CI: "true" },
  };
}

/** A command's combined output, of which only the last `tailBytes` are returned. */
class OutputTail {
  private readonly chunks: Buffer[] = [];
  private kept = 0;

  constructor(private readonly tailBytes: number) {}

  readonly keep = (chunk: Buffer): void => {
    this.chunks.push(chunk);
    this.kept += chunk.byteLength;
    while (
      this.kept > this.tailBytes * OUTPUT_BUFFER_TAILS &&
      this.chunks.length > 1
    ) {
      const oldest = this.chunks.shift();
      if (!oldest) throw new Error("no output chunk left to drop");
      this.kept -= oldest.byteLength;
    }
  };

  text(): string {
    const combined = Buffer.concat(this.chunks);
    return combined.byteLength > this.tailBytes
      ? `[... ${String(combined.byteLength - this.tailBytes)} bytes trimmed]\n${combined.subarray(-this.tailBytes).toString("utf8")}`
      : combined.toString("utf8");
  }
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
    const tail = new OutputTail(tailBytes);
    let timedOut = false;

    const { file, args, env } = invocation(command, cwd, timeoutMs, sandbox);
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", tail.keep);
    child.stderr.on("data", tail.keep);

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
      resolve({
        exitCode: timedOut ? null : code,
        output: tail.text(),
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
        TEST_OUTPUT_TAIL_BYTES,
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
