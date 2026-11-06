/**
 * Test runs execute code from the pull request inside the job that holds the
 * Anthropic key and a token that can write to pull requests. On Linux each run
 * gets its own network, process and mount namespaces: loopback only, no view
 * of the action's process or its environment, and the runner's home, temp
 * directories and /run (the Docker and DNS sockets) replaced by empty ones.
 * The working tree is mounted back in, with .git read-only, so nothing the
 * test writes can run later outside the sandbox through a hook or config.
 * The command runs as the runner user with no supplementary groups and
 * no_new_privs, so it cannot use sudo or the Docker group.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MS_PER_SECOND } from "./budget.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;

/** The only variables a test sees from the job: what toolchains need to run, and nothing that holds a credential. */
const PASSED_THROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "LD_LIBRARY_PATH",
  "PKG_CONFIG_PATH",
  "GOROOT",
  "GOPATH",
  "GOMODCACHE",
  "GOTOOLCHAIN",
  "GOFLAGS",
  "pythonLocation",
  "Python_ROOT_DIR",
  "Python2_ROOT_DIR",
  "Python3_ROOT_DIR",
  "VIRTUAL_ENV",
  "JAVA_HOME",
];

export function testEnvironment(
  from: NodeJS.ProcessEnv,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  // The module proxy is unreachable anyway; off makes Go fail at once instead of retrying.
  // Go's build cache goes outside ~/.cache, which the sandbox mounts read-only.
  return {
    ...env,
    HOME: home,
    CI: "true",
    GOPROXY: "off",
    GOCACHE: `${home}/.go-build`,
  };
}

// Runs as root inside the new namespaces. Mounts to keep are moved aside
// before the directories above them are hidden, then moved back.
const SETUP = `set -eu
uid=$1 gid=$2 cwd=$3 keep=$4 hide=$5
shift 5
stage=$(mktemp -d /run/pr-verify.XXXXXX)
n=0
while IFS=' ' read -r mode dir; do
  n=$((n + 1))
  [ -n "$dir" ] && [ -e "$dir" ] || continue
  if [ -d "$dir" ]; then mkdir "$stage/$n"; else touch "$stage/$n"; fi
  mount --rbind "$dir" "$stage/$n"
done <<KEEP
$keep
KEEP
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  mount -t tmpfs -o "mode=0755,uid=$uid,gid=$gid" tmpfs "$dir"
done <<HIDE
$hide
HIDE
n=0
while IFS=' ' read -r mode dir; do
  n=$((n + 1))
  [ -e "$stage/$n" ] || continue
  if [ -d "$stage/$n" ]; then mkdir -p "$dir"; else mkdir -p "$(dirname "$dir")"; touch "$dir"; fi
  mount --move "$stage/$n" "$dir"
  if [ "$mode" = ro ]; then mount -o remount,bind,ro "$dir"; fi
done <<KEEP
$keep
KEEP
mount -t tmpfs -o mode=0755 tmpfs /run
ip link set lo up
cd "$cwd"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"`;

export interface SandboxedCommand {
  file: string;
  args: string[];
}

export class Sandbox {
  private constructor(
    private readonly uid: number,
    private readonly gid: number,
    private readonly home: string,
    private readonly hidden: string[],
    private readonly readOnly: string[],
  ) {}

  /** The sandbox for this runner. Throws where one cannot be built, since running the PR's code without it would expose the job's secrets. */
  static async forRunner(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Sandbox> {
    if (process.platform !== "linux" || !process.getuid || !process.getgid) {
      throw new Error(
        `Test runs are sandboxed, which needs a Linux runner; this one is ${process.platform}.`,
      );
    }
    const home = os.homedir();
    const under = (dir: string, parent: string) =>
      dir === parent || dir.startsWith(`${parent}/`);
    const hidden = [home, "/tmp"];
    const runnerTemp = env.RUNNER_TEMP;
    if (runnerTemp && !hidden.some((h) => under(runnerTemp, h)))
      hidden.push(runnerTemp);
    // Toolchain caches a suite may read, such as Go's module cache. Read-only, so a test cannot plant anything in them.
    const readOnly = [
      env.GOMODCACHE,
      path.join(home, "go", "pkg", "mod"),
      path.join(home, ".local"),
      path.join(home, ".cache"),
    ].filter(
      (dir): dir is string =>
        dir !== undefined &&
        existsSync(dir) &&
        hidden.some((h) => under(dir, h)),
    );
    const sandbox = new Sandbox(
      process.getuid(),
      process.getgid(),
      home,
      hidden,
      [...new Set(readOnly)],
    );

    const probe = sandbox.wrap("true", home, PROBE_TIMEOUT_MS);
    try {
      await execFileAsync(probe.file, probe.args);
    } catch (error) {
      throw new Error(
        `Could not build the sandbox test runs need. It uses passwordless sudo, unshare and setpriv, as on GitHub-hosted Ubuntu runners: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return sandbox;
  }

  /** The program and arguments that run `command` in `cwd` inside the sandbox. The sandbox kills it after `timeoutMs`. */
  wrap(command: string, cwd: string, timeoutMs: number): SandboxedCommand {
    const keep = [
      `rw ${cwd}`,
      `ro ${path.join(cwd, ".git")}`,
      ...this.readOnly.map((dir) => `ro ${dir}`),
    ];
    const env = Object.entries(testEnvironment(process.env, this.home)).map(
      ([name, value]) => `${name}=${value}`,
    );
    return {
      file: "sudo",
      args: [
        "-n",
        "timeout",
        "-s",
        "KILL",
        `${String(Math.ceil(timeoutMs / MS_PER_SECOND))}s`,
        "unshare",
        "--net",
        "--pid",
        "--fork",
        "--kill-child",
        "--mount",
        "--mount-proc",
        "--",
        "sh",
        "-c",
        SETUP,
        "pr-verify-sandbox",
        String(this.uid),
        String(this.gid),
        cwd,
        keep.join("\n"),
        this.hidden.join("\n"),
        "env",
        "-i",
        ...env,
        "bash",
        "-c",
        command,
      ],
    };
  }
}
