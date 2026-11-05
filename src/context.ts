/**
 * Everything the agent is allowed to know, gathered deterministically:
 * the diff, the repository map, the guidance file, and (for a red gate) the
 * failing step's log. Also the scrubber that keeps secrets out of all of it.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getExecOutput } from "@actions/exec";
import type { getOctokit } from "@actions/github";
import { parseDiff } from "./diff.js";
import type { PullRequestRef } from "./types.js";

export type Octokit = ReturnType<typeof getOctokit>;

const GUIDANCE_CAP_BYTES = 8 * 1024;
const MAP_CAP_BYTES = 48 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;

/** The most items GitHub returns in one page of a list. */
export const PAGE_SIZE = 100;
const CHECK_ATTR_FIELDS = 3;
const MIN_SECRET_LENGTH = 8;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

export async function git(
  args: string[],
  cwd: string,
  input?: string,
): Promise<string> {
  const result = await getExecOutput("git", args, {
    cwd,
    silent: true,
    ignoreReturnCode: true,
    ...(input === undefined ? {} : { input: Buffer.from(input, "utf8") }),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(result.exitCode)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

const NOISE_FILES = [
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb?$/,
  /^poetry\.lock$/,
  /^Pipfile\.lock$/,
  /^uv\.lock$/,
  /^go\.sum$/,
  /^Cargo\.lock$/,
  /^Gemfile\.lock$/,
  /^packages\.lock\.json$/,
  /^composer\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
];

/** Machine-written files: lockfiles, minified bundles, source maps. A reviewer skips them, and patches may not touch them. */
export function isNoise(filePath: string): boolean {
  const base = path.posix.basename(filePath.replace(/\\/g, "/"));
  return NOISE_FILES.some((p) => p.test(base));
}

export interface PullRequestDiff {
  /** The diff the agent sees. */
  text: string;
  /** Changed files left out of `text` because they are machine-written. */
  omitted: string[];
}

/** Drops whole file sections whose path is noise, or that `generated` marks as generated. */
export function dropNoise(
  diffText: string,
  generated: (path: string) => boolean = () => false,
): PullRequestDiff {
  const sections: string[][] = [];
  for (const line of diffText.split("\n")) {
    const current = sections.at(-1);
    if (line.startsWith("diff --git ") || current === undefined)
      sections.push([line]);
    else current.push(line);
  }
  const kept: string[] = [];
  const omitted: string[] = [];
  for (const section of sections) {
    const text = section.join("\n");
    const file = parseDiff(text)[0];
    if (file && (isNoise(file.path) || generated(file.path)))
      omitted.push(file.path);
    else kept.push(text);
  }
  return { text: kept.join("\n"), omitted };
}

/** Paths among `paths` that .gitattributes marks `linguist-generated`, the marker GitHub collapses diffs by. */
async function generatedPaths(
  paths: string[],
  cwd: string,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  // With -z, each answer is three NUL-terminated fields: path, attribute, value.
  const out = await git(
    ["check-attr", "-z", "--stdin", "linguist-generated"],
    cwd,
    `${paths.join("\0")}\0`,
  );
  const fields = out.split("\0");
  const generated = new Set<string>();
  for (
    let i = 0;
    i + CHECK_ATTR_FIELDS <= fields.length;
    i += CHECK_ATTR_FIELDS
  ) {
    const [file, , value] = fields.slice(i, i + CHECK_ATTR_FIELDS);
    if (file !== undefined && (value === "true" || value === "set"))
      generated.add(file);
  }
  return generated;
}

/** The PR diff from the merge base, which is what GitHub shows on the Files tab, without machine-written files. */
export async function collectDiff(
  pr: PullRequestRef,
  cwd: string,
): Promise<PullRequestDiff> {
  const text = await git(
    [
      "diff",
      "--no-color",
      "--unified=3",
      "--merge-base",
      pr.baseSha,
      pr.headSha,
    ],
    cwd,
  );
  const generated = await generatedPaths(
    parseDiff(text).map((f) => f.path),
    cwd,
  );
  return dropNoise(text, (p) => generated.has(p));
}

export async function trackedFiles(cwd: string): Promise<string[]> {
  const out = await git(["ls-files", "-z"], cwd);
  return out.split("\0").filter((p) => p.length > 0);
}

export interface RepositoryMap {
  text: string;
  fileCount: number;
  truncated: boolean;
}

/** Orders strings by UTF-16 code unit, as `sort()` does with no comparator. */
export function byCodeUnits(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** One path per line, sorted, capped so a huge monorepo can't eat the prompt budget. */
export function buildRepositoryMap(
  files: string[],
  capBytes = MAP_CAP_BYTES,
): RepositoryMap {
  const sorted = [...files].sort(byCodeUnits);
  const lines: string[] = [];
  let bytes = 0;
  for (const file of sorted) {
    const cost = Buffer.byteLength(file, "utf8") + 1;
    if (bytes + cost > capBytes) {
      lines.push(
        `... ${String(sorted.length - lines.length)} more files omitted`,
      );
      return {
        text: lines.join("\n"),
        fileCount: sorted.length,
        truncated: true,
      };
    }
    lines.push(file);
    bytes += cost;
  }
  return { text: lines.join("\n"), fileCount: sorted.length, truncated: false };
}

export interface Guidance {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Reads the repository guidance file, capped at 8 KB. Null when absent. */
export async function readGuidance(
  repoRoot: string,
  relativePath: string,
  capBytes = GUIDANCE_CAP_BYTES,
): Promise<Guidance | null> {
  let raw: Buffer;
  try {
    raw = await readFile(path.join(repoRoot, relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return capUtf8(raw, capBytes);
}

export function capUtf8(raw: Buffer, capBytes: number): Guidance {
  if (raw.byteLength <= capBytes) {
    return {
      text: raw.toString("utf8"),
      bytes: raw.byteLength,
      truncated: false,
    };
  }
  // Cut on a UTF-8 boundary so we never emit a half character.
  let end = capBytes;
  while (
    end > 0 &&
    (raw.readUInt8(end) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS
  )
    end -= 1;
  return {
    text: raw.subarray(0, end).toString("utf8"),
    bytes: end,
    truncated: true,
  };
}

/**
 * Replaces secret values and well-known token shapes before any text reaches
 * a prompt, a comment or the run record.
 */
export class Scrubber {
  private readonly secrets: string[];

  private static readonly PATTERNS: RegExp[] = [
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_\w{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];

  constructor(secrets: (string | undefined)[]) {
    this.secrets = secrets
      .filter(
        (s): s is string =>
          typeof s === "string" && s.length >= MIN_SECRET_LENGTH,
      )
      .sort((a, b) => b.length - a.length);
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets)
      out = out.split(secret).join("[redacted]");
    for (const pattern of Scrubber.PATTERNS)
      out = out.replace(pattern, "[redacted]");
    return out;
  }
}

export interface FailingStep {
  stepName: string;
  log: string;
}

/**
 * Finds the gate job in the current workflow run and returns the log of its
 * failing step, trimmed to the last 64 KB.
 */
export async function fetchFailingStepLog(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  gateJobName: string,
): Promise<FailingStep | null> {
  const jobs = await octokit.paginate(
    octokit.rest.actions.listJobsForWorkflowRun,
    {
      owner,
      repo,
      run_id: runId,
      per_page: PAGE_SIZE,
    },
  );
  const gate = jobs.find(
    (job) => job.name === gateJobName || job.name.endsWith(`/ ${gateJobName}`),
  );
  if (!gate) return null;
  const failing = gate.steps?.find((step) => step.conclusion === "failure");
  if (!failing) return null;

  const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
    owner,
    repo,
    job_id: gate.id,
  });
  const log =
    typeof response.data === "string" ? response.data : String(response.data);
  return { stepName: failing.name, log: extractStepLog(log, failing.name) };
}

/** The index of the last `##[group]` line whose header passes `matches`, or -1. */
function lastGroup(
  lines: string[],
  matches: (header: string) => boolean,
): number {
  let found = -1;
  for (const [i, line] of lines.entries()) {
    if (
      line.startsWith("##[group]") &&
      matches(line.slice("##[group]".length).trim())
    ) {
      found = i;
    }
  }
  return found;
}

/** Where the step's section starts in the log's lines, or -1 when no section can be tied to it. */
function stepGroupStart(lines: string[], stepName: string): number {
  const named = lastGroup(
    lines,
    (header) => header === stepName || header === `Run ${stepName}`,
  );
  if (named !== -1) return named;
  // The group header names the command, not the step. Use the section containing the first error.
  const errorAt = lines.findIndex((l) => l.startsWith("##[error]"));
  if (errorAt === -1) return -1;
  return lastGroup(lines.slice(0, errorAt + 1), () => true);
}

/**
 * Pulls one step's section out of a job log. GitHub separates steps with a
 * `##[group]` line that names the step; the failing step's section carries
 * the `##[error]` marker. Falls back to the tail of the whole log.
 */
export function extractStepLog(
  log: string,
  stepName: string,
  tailBytes = LOG_TAIL_BYTES,
): string {
  const lines = log.split("\n");
  const stripped = lines.map((l) =>
    l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""),
  );

  const start = stepGroupStart(stripped, stepName);
  if (start === -1) return tail(stripped.join("\n"), tailBytes);

  const next = stripped.findIndex(
    (l, i) => i > start && l.startsWith("##[group]"),
  );
  const end = next === -1 ? stripped.length : next;
  return tail(stripped.slice(start, end).join("\n"), tailBytes);
}

export function tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return text;
  const slice = buffer.subarray(buffer.byteLength - bytes);
  const firstNewline = slice.indexOf("\n");
  return `[... ${String(buffer.byteLength - bytes)} bytes trimmed]\n${slice.subarray(firstNewline + 1).toString("utf8")}`;
}
