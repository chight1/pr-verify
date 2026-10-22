/**
 * Everything the agent is allowed to know, gathered deterministically:
 * the diff, the repository map, the guidance file, and (for a red gate) the
 * failing step's log. Also the scrubber that keeps secrets out of all of it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getExecOutput } from '@actions/exec';
import type { getOctokit } from '@actions/github';
import type { PullRequestRef } from './types.js';

export type Octokit = ReturnType<typeof getOctokit>;

export const GUIDANCE_CAP_BYTES = 8 * 1024;
export const MAP_CAP_BYTES = 48 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;

export async function git(args: string[], cwd: string): Promise<string> {
  const result = await getExecOutput('git', args, { cwd, silent: true, ignoreReturnCode: true });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** The PR diff from the merge base, which is what GitHub shows on the Files tab. */
export async function collectDiff(pr: PullRequestRef, cwd: string): Promise<string> {
  return git(['diff', '--no-color', '--unified=3', '--merge-base', pr.baseSha, pr.headSha], cwd);
}

export async function trackedFiles(cwd: string): Promise<string[]> {
  const out = await git(['ls-files', '-z'], cwd);
  return out.split('\0').filter((p) => p.length > 0);
}

export interface RepositoryMap {
  text: string;
  fileCount: number;
  truncated: boolean;
}

/** One path per line, sorted, capped so a huge monorepo can't eat the prompt budget. */
export function buildRepositoryMap(files: string[], capBytes = MAP_CAP_BYTES): RepositoryMap {
  const sorted = [...files].sort();
  const lines: string[] = [];
  let bytes = 0;
  for (const file of sorted) {
    const cost = Buffer.byteLength(file, 'utf8') + 1;
    if (bytes + cost > capBytes) {
      lines.push(`... ${sorted.length - lines.length} more files omitted`);
      return { text: lines.join('\n'), fileCount: sorted.length, truncated: true };
    }
    lines.push(file);
    bytes += cost;
  }
  return { text: lines.join('\n'), fileCount: sorted.length, truncated: false };
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return capUtf8(raw, capBytes);
}

export function capUtf8(raw: Buffer, capBytes: number): Guidance {
  if (raw.byteLength <= capBytes) {
    return { text: raw.toString('utf8'), bytes: raw.byteLength, truncated: false };
  }
  // Cut on a UTF-8 boundary so we never emit a half character.
  let end = capBytes;
  while (end > 0 && (raw[end]! & 0xc0) === 0x80) end -= 1;
  return { text: raw.subarray(0, end).toString('utf8'), bytes: end, truncated: true };
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
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];

  constructor(secrets: Array<string | undefined>) {
    this.secrets = secrets
      .filter((s): s is string => typeof s === 'string' && s.length >= 8)
      .sort((a, b) => b.length - a.length);
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    for (const pattern of Scrubber.PATTERNS) out = out.replace(pattern, '[redacted]');
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
  const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });
  const gate = jobs.find((job) => job.name === gateJobName || job.name.endsWith(`/ ${gateJobName}`));
  if (!gate) return null;
  const failing = gate.steps?.find((step) => step.conclusion === 'failure');
  if (!failing) return null;

  const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
    owner,
    repo,
    job_id: gate.id,
  });
  const log = typeof response.data === 'string' ? response.data : String(response.data);
  return { stepName: failing.name, log: extractStepLog(log, failing.name) };
}

/**
 * Pulls one step's section out of a job log. GitHub separates steps with a
 * `##[group]` line that names the step; the failing step's section carries
 * the `##[error]` marker. Falls back to the tail of the whole log.
 */
export function extractStepLog(log: string, stepName: string, tailBytes = LOG_TAIL_BYTES): string {
  const lines = log.split('\n');
  const stripped = lines.map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''));

  let start = -1;
  for (let i = 0; i < stripped.length; i += 1) {
    const line = stripped[i]!;
    if (line.startsWith('##[group]')) {
      const header = line.slice('##[group]'.length).trim();
      if (header === stepName || header === `Run ${stepName}`) start = i;
    }
  }
  if (start === -1) {
    // The group header names the command, not the step. Use the section containing the first error.
    const errorAt = stripped.findIndex((l) => l.startsWith('##[error]'));
    if (errorAt !== -1) {
      for (let i = errorAt; i >= 0; i -= 1) {
        if (stripped[i]!.startsWith('##[group]')) {
          start = i;
          break;
        }
      }
    }
  }
  if (start === -1) return tail(stripped.join('\n'), tailBytes);

  let end = stripped.length;
  for (let i = start + 1; i < stripped.length; i += 1) {
    if (stripped[i]!.startsWith('##[group]')) {
      end = i;
      break;
    }
  }
  return tail(stripped.slice(start, end).join('\n'), tailBytes);
}

export function tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= bytes) return text;
  const slice = buffer.subarray(buffer.byteLength - bytes);
  const firstNewline = slice.indexOf(0x0a);
  return `[... ${buffer.byteLength - bytes} bytes trimmed]\n${slice.subarray(firstNewline + 1).toString('utf8')}`;
}
