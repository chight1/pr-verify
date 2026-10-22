/**
 * Posting policy. One review per run with the comment event only; findings
 * on diff lines go inline, the rest into the body; a hidden marker tags
 * everything so a later run can find what was already said.
 */

import type { Octokit } from './context.js';
import { git } from './context.js';
import { isCommentable, parseDiff, type DiffFile } from './diff.js';
import type { Finding, Patch, PriorFinding, PullRequestRef } from './types.js';

const MARKER = 'pr-verify';
const FINDING_MARKER = new RegExp(`<!-- ${MARKER}:finding (\\{.*?\\}) -->`, 'g');
const COMMENT_MARKER = (key: string) => `<!-- ${MARKER}:comment ${key} -->`;

export function findingMarker(finding: PriorFinding): string {
  return `<!-- ${MARKER}:finding ${JSON.stringify(finding)} -->`;
}

export function parseFindingMarkers(text: string): PriorFinding[] {
  const out: PriorFinding[] = [];
  for (const match of text.matchAll(FINDING_MARKER)) {
    try {
      const parsed = JSON.parse(match[1]!) as Partial<PriorFinding>;
      if (
        typeof parsed.file === 'string' &&
        typeof parsed.line === 'number' &&
        typeof parsed.title === 'string' &&
        typeof parsed.category === 'string' &&
        typeof parsed.headSha === 'string'
      ) {
        out.push({
          file: parsed.file,
          line: parsed.line,
          title: parsed.title,
          category: parsed.category,
          headSha: parsed.headSha,
          verified: parsed.verified === true,
        });
      }
    } catch {
      // A marker someone edited by hand is not our problem; skip it.
    }
  }
  return out;
}

/** Every finding this action has posted on the PR, from review bodies and inline comments alike. */
export async function fetchPriorFindings(octokit: Octokit, pr: PullRequestRef): Promise<PriorFinding[]> {
  const [reviews, comments] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100,
    }),
  ]);
  const texts = [...reviews.map((r) => r.body ?? ''), ...comments.map((c) => c.body ?? '')];
  const seen = new Set<string>();
  const findings: PriorFinding[] = [];
  for (const text of texts) {
    for (const finding of parseFindingMarkers(text)) {
      const key = `${finding.file}:${finding.line}:${finding.category}:${finding.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
    }
  }
  return findings;
}

export interface Resolution {
  /** Prior findings whose lines changed since they were posted. */
  resolved: PriorFinding[];
  /** Prior findings still standing, handed to the agent so it does not repeat them. */
  open: PriorFinding[];
}

/**
 * A prior finding is resolved when the lines it pointed at changed between the
 * commit it was posted on and the current head. Decided with git, not the model.
 */
export async function resolvePriorFindings(
  prior: PriorFinding[],
  headSha: string,
  cwd: string,
  diffBetween: (from: string, to: string, file: string) => Promise<string | null> = (from, to, file) =>
    git(['diff', '--no-color', '--unified=0', from, to, '--', file], cwd).catch(() => null),
): Promise<Resolution> {
  const resolved: PriorFinding[] = [];
  const open: PriorFinding[] = [];
  for (const finding of prior) {
    if (finding.headSha === headSha) {
      open.push(finding);
      continue;
    }
    const diff = await diffBetween(finding.headSha, headSha, finding.file);
    if (diff === null) {
      // The old commit is gone (force push). We can't tell, so don't claim it was fixed.
      open.push(finding);
      continue;
    }
    if (lineChanged(parseDiff(diff), finding.file, finding.line)) resolved.push(finding);
    else open.push(finding);
  }
  return { resolved, open };
}

export function lineChanged(files: DiffFile[], file: string, line: number): boolean {
  const entry = files.find((f) => f.oldPath === file || f.path === file);
  if (!entry) return false;
  if (entry.status === 'deleted') return true;
  return entry.hunks.some((h) => {
    // A pure insertion has oldLines 0 and does not touch the line itself.
    if (h.oldLines === 0) return false;
    return line >= h.oldStart && line < h.oldStart + h.oldLines;
  });
}

/** True when a new finding says the same thing as one already open on the PR. */
export function isDuplicate(finding: Finding, open: PriorFinding[]): boolean {
  const title = finding.title.trim().toLowerCase();
  return open.some(
    (p) =>
      p.file === finding.file &&
      p.category === finding.category &&
      (p.title.trim().toLowerCase() === title || Math.abs(p.line - finding.line) <= 2),
  );
}

export interface ReviewTrail {
  filesRead: string[];
  tests: Array<{ description: string; exitCode: number | null }>;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  wallMs: number;
  runUrl: string;
}

export interface ReviewDraft {
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

function fenceDiff(diff: string): string {
  return `\`\`\`diff\n${diff.trimEnd()}\n\`\`\``;
}

function renderFinding(finding: Finding, patches: Patch[], headSha: string, withLocation: boolean): string {
  const prior: PriorFinding = {
    category: finding.category,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    verified: finding.verified,
    headSha,
  };
  const badge = finding.verified ? 'Verified' : `Unverified, ${finding.confidence} confidence`;
  const lines = [`**${finding.title}** · ${finding.category} · ${badge}`];
  if (withLocation) lines.push(`\`${finding.file}:${finding.line}\``);
  lines.push('', finding.explanation);

  const test = finding.testPatch !== undefined ? patches.find((p) => p.id === finding.testPatch) : undefined;
  const fix = finding.fixPatch !== undefined ? patches.find((p) => p.id === finding.fixPatch) : undefined;
  if (test && finding.testPatchVerified) {
    lines.push('', '<details><summary>Test that fails on this commit</summary>', '', fenceDiff(test.diff), '</details>');
  }
  if (fix && finding.fixPatchVerified) {
    lines.push('', '<details><summary>Fix that makes it pass</summary>', '', fenceDiff(fix.diff), '</details>');
  }
  lines.push('', findingMarker(prior));
  return lines.join('\n');
}

/**
 * Splits findings into inline comments (diff lines) and body entries (the
 * rest), and writes the body: verified first, unverified, resolved, trail.
 */
export function buildReview(
  findings: Finding[],
  patches: Patch[],
  resolved: PriorFinding[],
  diffFiles: DiffFile[],
  headSha: string,
  trail: ReviewTrail,
): ReviewDraft {
  const comments: ReviewDraft['comments'] = [];
  const bodyFindings: Finding[] = [];
  for (const finding of findings) {
    if (isCommentable(diffFiles, finding.file, finding.line)) {
      finding.placement = 'inline';
      comments.push({ path: finding.file, line: finding.line, body: renderFinding(finding, patches, headSha, false) });
    } else {
      finding.placement = 'body';
      bodyFindings.push(finding);
    }
  }

  const verified = bodyFindings.filter((f) => f.verified);
  const unverified = bodyFindings.filter((f) => !f.verified);
  const sections: string[] = [];

  const inlineCount = comments.length;
  const summary = [
    `${findings.filter((f) => f.verified).length} verified`,
    `${findings.filter((f) => !f.verified).length} unverified`,
    `${resolved.length} resolved since the last review`,
  ].join(', ');
  sections.push(`### PR Verify review\n\n${summary}.${inlineCount > 0 ? ` ${inlineCount} inline.` : ''}`);

  if (verified.length > 0) {
    sections.push(`### Verified\n\n${verified.map((f) => renderFinding(f, patches, headSha, true)).join('\n\n---\n\n')}`);
  }
  if (unverified.length > 0) {
    sections.push(`### Unverified\n\n${unverified.map((f) => renderFinding(f, patches, headSha, true)).join('\n\n---\n\n')}`);
  }
  if (resolved.length > 0) {
    sections.push(
      `### Resolved by this push\n\n${resolved.map((r) => `- \`${r.file}:${r.line}\` ${r.title}`).join('\n')}`,
    );
  }

  const trailLines = [
    `Files read: ${trail.filesRead.length > 0 ? trail.filesRead.map((f) => `\`${f}\``).join(', ') : 'none'}`,
    `Tests run by the agent: ${
      trail.tests.length > 0
        ? trail.tests.map((t) => `${t.description} (exit ${t.exitCode ?? 'timeout'})`).join('; ')
        : 'none'
    }`,
    `Tokens: ${trail.inputTokens} in, ${trail.cachedInputTokens} cached, ${trail.outputTokens} out`,
    `Wall time: ${Math.round(trail.wallMs / 1000)}s`,
    `[Run record](${trail.runUrl})`,
  ];
  sections.push(`<details><summary>Trail</summary>\n\n${trailLines.map((l) => `- ${l}`).join('\n')}\n\n</details>`);
  sections.push(`<!-- ${MARKER}:review ${headSha} -->`);

  return { body: sections.join('\n\n'), comments };
}

/** Posts the review with the comment event. Never approve, never request changes. */
export async function postReview(octokit: Octokit, pr: PullRequestRef, draft: ReviewDraft): Promise<number> {
  const response = await octokit.rest.pulls.createReview({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    commit_id: pr.headSha,
    event: 'COMMENT',
    body: draft.body,
    comments: draft.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })),
  });
  return response.data.id;
}

/** Creates or updates the single PR comment identified by `key`. Used for red-gate verdicts. */
export async function upsertComment(
  octokit: Octokit,
  pr: PullRequestRef,
  key: string,
  body: string,
): Promise<number> {
  const marker = COMMENT_MARKER(key);
  const full = `${body}\n\n${marker}`;
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const mine = existing.find((c) => (c.body ?? '').includes(marker));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner: pr.owner, repo: pr.repo, comment_id: mine.id, body: full });
    return mine.id;
  }
  const created = await octokit.rest.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    body: full,
  });
  return created.data.id;
}
