/**
 * How often posted findings turn out wrong. A person marks a finding wrong
 * with a thumbs-down on its inline comment; this counts those per category,
 * verified and unverified apart, across every pull request in a repository.
 * Findings in a review body are not counted, since a review body takes no
 * reactions through the API.
 */

import type { Octokit } from './context.js';
import { DEFAULT_TOKEN_LOGIN, parseFindingMarkers } from './review.js';

export interface RatedComment {
  body: string;
  thumbsDown: number;
}

export interface PrecisionRow {
  category: string;
  verified: boolean;
  posted: number;
  markedWrong: number;
}

export function tallyPrecision(comments: RatedComment[]): PrecisionRow[] {
  const rows = new Map<string, PrecisionRow>();
  for (const comment of comments) {
    for (const finding of parseFindingMarkers(comment.body)) {
      const key = `${finding.category}:${finding.verified}`;
      const row = rows.get(key) ?? { category: finding.category, verified: finding.verified, posted: 0, markedWrong: 0 };
      row.posted += 1;
      if (comment.thumbsDown > 0) row.markedWrong += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || Number(b.verified) - Number(a.verified));
}

/** Every inline comment `author` posted in the repository, with its thumbs-down count. */
export async function fetchRatedComments(octokit: Octokit, owner: string, repo: string, author = DEFAULT_TOKEN_LOGIN): Promise<RatedComment[]> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewCommentsForRepo, { owner, repo, per_page: 100 });
  return comments
    .filter((c) => c.user?.login === author)
    .map((c) => ({ body: c.body, thumbsDown: c.reactions?.['-1'] ?? 0 }));
}

export function renderPrecision(rows: PrecisionRow[]): string {
  if (rows.length === 0) return 'No inline findings posted yet.';
  const lines = rows.map((r) => {
    const precision = Math.round((100 * (r.posted - r.markedWrong)) / r.posted);
    return `${r.category.padEnd(14)} ${(r.verified ? 'verified' : 'unverified').padEnd(11)} ${String(r.posted).padStart(6)} ${String(r.markedWrong).padStart(6)} ${`${precision}%`.padStart(9)}`;
  });
  return [`${'category'.padEnd(14)} ${'kind'.padEnd(11)} ${'posted'.padStart(6)} ${'wrong'.padStart(6)} ${'precision'.padStart(9)}`, ...lines].join('\n');
}
