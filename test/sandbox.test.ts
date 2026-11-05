import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, testEnvironment } from "../src/sandbox.js";
import { runCommand } from "../src/verify.js";

describe("testEnvironment", () => {
  it("passes toolchain variables through and drops everything else, credentials included", () => {
    const env = testEnvironment(
      {
        PATH: "/bin",
        GOROOT: "/go",
        "INPUT_ANTHROPIC-API-KEY": "sk-ant",
        GITHUB_TOKEN: "ghs",
        ACTIONS_RUNTIME_TOKEN: "rt",
      },
      "/home/runner",
    );
    expect(env).toEqual({
      PATH: "/bin",
      GOROOT: "/go",
      HOME: "/home/runner",
      CI: "true",
      GOPROXY: "off",
      GOCACHE: "/tmp/go-build",
    });
  });
});

const canSandbox =
  process.platform === "linux" &&
  spawnSync("sudo", ["-n", "true"]).status === 0;

// Runs for real in CI, whose runner has the passwordless sudo the sandbox is built with.
describe.runIf(canSandbox)("Sandbox", () => {
  let sandbox: Sandbox;
  let dir: string;
  const last = (output: string) => output.trim().split("\n").at(-1);

  beforeAll(async () => {
    sandbox = await Sandbox.forRunner();
    dir = mkdtempSync(path.join(os.tmpdir(), "pr-verify-sandbox-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (command: string, timeoutMs = 30_000) =>
    runCommand(command, dir, timeoutMs, 64 * 1024, sandbox);

  it("runs in the working tree and keeps what the command writes there", async () => {
    const result = await run("pwd && echo kept > out.txt");
    expect(result.exitCode).toBe(0);
    expect(last(result.output)).toBe(dir);
    expect(readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("kept\n");
  });

  it("has no network", async () => {
    const result = await run(
      "(exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && echo open || echo closed",
    );
    expect(last(result.output)).toBe("closed");
  });

  it("cannot see the processes or environment outside it", async () => {
    // CI sets the canary on the test step, so it is in the initial environment of every process outside.
    const canary = process.env.PR_VERIFY_CANARY;
    expect(canary).toBeTruthy();
    const result = await run(
      `env; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'; test -e /proc/${process.pid} && echo seen || echo unseen`,
    );
    expect(result.output).not.toContain(canary);
    expect(last(result.output)).toBe("unseen");
  });

  it("cannot use sudo or reach the Docker socket", async () => {
    const result = await run(
      "sudo -n true 2>/dev/null && echo root || echo no-root; test -e /var/run/docker.sock && echo docker || echo no-docker",
    );
    expect(result.output.trim().split("\n")).toEqual(["no-root", "no-docker"]);
  });

  it("cannot write to .git, so nothing it leaves there runs later outside", async () => {
    const result = await run(
      "touch .git/hooks/post-checkout 2>/dev/null && echo wrote || echo read-only",
    );
    expect(last(result.output)).toBe("read-only");
  });

  it("hides the runner's home directory", async () => {
    const marker = path.join(os.homedir(), `.pr-verify-marker-${process.pid}`);
    writeFileSync(marker, "");
    try {
      const result = await run(
        `test -e ${marker} && echo visible || echo hidden`,
      );
      expect(last(result.output)).toBe("hidden");
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("kills a command that runs past its timeout", async () => {
    const result = await run("sleep 60", 2_000);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.durationMs).toBeLessThan(20_000);
  });
});
