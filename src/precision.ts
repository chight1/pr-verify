/**
 * How often posted findings turn out wrong. A person marks a finding wrong
 * with a thumbs-down on its inline comment; this counts those per category,
 * verified and unverified apart, across every pull request in a repository.
 * Findings in a review body are not counted, since a review body takes no
 * reactions through the API.
 */

import { PAGE_SIZE, type Octokit } from "./claude-context.js";
import {
  DEFAULT_TOKEN_LOGIN,
  parseFindingMarkers,
  postedBy,
} from "./comment-markers.js";

const PERCENT = 100;
const COLUMN_WIDTHS = {
  category: 14,
  kind: 11,
  posted: 6,
  wrong: 6,
  precision: 9,
} as const;

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
      const key = `${finding.category}:${String(finding.verified)}`;
      const row = rows.get(key) ?? {
        category: finding.category,
        verified: finding.verified,
        posted: 0,
        markedWrong: 0,
      };
      row.posted += 1;
      if (comment.thumbsDown > 0) row.markedWrong += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      Number(b.verified) - Number(a.verified),
  );
}

/** Every inline comment `author` posted in the repository, with its thumbs-down count. */
export async function fetchRatedComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  author = DEFAULT_TOKEN_LOGIN,
): Promise<RatedComment[]> {
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewCommentsForRepo,
    { owner, repo, per_page: PAGE_SIZE },
  );
  return comments
    .filter((c) => postedBy(c, author))
    .map((c) => ({ body: c.body, thumbsDown: c.reactions?.["-1"] ?? 0 }));
}

export function renderPrecision(rows: PrecisionRow[]): string {
  if (rows.length === 0) return "No inline findings posted yet.";
  const lines = rows.map((r) => {
    const precision = Math.round(
      (PERCENT * (r.posted - r.markedWrong)) / r.posted,
    );
    const percent = `${String(precision)}%`;
    return `${r.category.padEnd(COLUMN_WIDTHS.category)} ${(r.verified ? "verified" : "unverified").padEnd(COLUMN_WIDTHS.kind)} ${String(r.posted).padStart(COLUMN_WIDTHS.posted)} ${String(r.markedWrong).padStart(COLUMN_WIDTHS.wrong)} ${percent.padStart(COLUMN_WIDTHS.precision)}`;
  });
  return [
    `${"category".padEnd(COLUMN_WIDTHS.category)} ${"kind".padEnd(COLUMN_WIDTHS.kind)} ${"posted".padStart(COLUMN_WIDTHS.posted)} ${"wrong".padStart(COLUMN_WIDTHS.wrong)} ${"precision".padStart(COLUMN_WIDTHS.precision)}`,
    ...lines,
  ].join("\n");
}
