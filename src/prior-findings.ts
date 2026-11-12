/**
 * Prior findings: what earlier runs posted on the PR and no review has
 * reported resolved yet, which of those this push resolved, and resolving
 * the review threads of the ones it did.
 */

import type { Octokit } from "./claude-context.js";
import { git, PAGE_SIZE } from "./claude-context.js";
import { parseDiff, type DiffFile } from "./diff.js";
import {
  findingKey,
  parseFindingMarkers,
  parsePostedFindings,
  parseResolvedMarkers,
  postedBy,
  type PostedFinding,
} from "./comment-markers.js";
import type { RecheckResult } from "./proof.js";
import type { PriorFinding, PullRequestRef, ResolvedFinding } from "./types.js";

/**
 * Every finding this action has posted on the PR and not yet reported
 * resolved, from review bodies and inline comments alike. Only comments by
 * `author` count.
 */
export async function fetchPriorFindings(
  octokit: Octokit,
  pr: PullRequestRef,
  author: string,
): Promise<PostedFinding[]> {
  const [reviews, comments] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: PAGE_SIZE,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: PAGE_SIZE,
    }),
  ]);
  const texts = [...reviews, ...comments]
    .filter((c) => postedBy(c, author))
    .map((c) => c.body);

  const resolved = new Set<string>();
  for (const text of texts) {
    for (const finding of parseResolvedMarkers(text))
      resolved.add(`${findingKey(finding)}:${finding.headSha}`);
  }

  const seen = new Set<string>();
  const findings: PostedFinding[] = [];
  for (const text of texts) {
    for (const posted of parsePostedFindings(text)) {
      const key = findingKey(posted.finding);
      if (resolved.has(`${key}:${posted.finding.headSha}`) || seen.has(key))
        continue;
      seen.add(key);
      findings.push(posted);
    }
  }
  return findings;
}

export interface Resolution {
  /** Prior findings this push resolved, with the evidence for each. */
  resolved: ResolvedFinding[];
  /** Prior findings still standing, handed to the agent so it does not repeat them. */
  open: PriorFinding[];
  /** Suite runs spent re-checking prior findings. */
  rechecks: number;
}

/** Runs a prior finding's test against the current head. */
export type Recheck = (testPatch: string) => Promise<RecheckResult>;
export type DiffBetween = (
  from: string,
  to: string,
  file: string,
) => Promise<string | null>;

/** Each re-check is a full suite run before the review starts, so only the first few prior findings get one. */
export const MAX_RECHECKS = 3;

export function gitDiffBetween(cwd: string): DiffBetween {
  return (from, to, file) =>
    git(["diff", "--no-color", "--unified=0", from, to, "--", file], cwd).catch(
      () => null,
    );
}

/**
 * Decides which prior findings this push resolved. Decided by the harness,
 * not the model.
 *
 * A verified finding carries the test that failed when it was posted, and
 * that test is run again on the current head. A pass resolves the finding
 * wherever the fix landed; a failure keeps it open even if its line was
 * edited. A finding without a usable test is resolved when the line it
 * pointed at changed since it was posted.
 */
export async function resolvePriorFindings(
  prior: PostedFinding[],
  headSha: string,
  recheck: Recheck,
  diffBetween: DiffBetween,
): Promise<Resolution> {
  const resolved: ResolvedFinding[] = [];
  const open: PriorFinding[] = [];
  let rechecks = 0;
  for (const { finding, testPatch } of prior) {
    if (finding.headSha === headSha) {
      open.push(finding);
      continue;
    }
    if (testPatch !== null && rechecks < MAX_RECHECKS) {
      rechecks += 1;
      const result = await recheck(testPatch);
      if (result === "passes") {
        resolved.push({ ...finding, evidence: "test-passes" });
        continue;
      }
      if (result === "fails") {
        open.push(finding);
        continue;
      }
      // The test no longer fits this commit. Fall back to the line.
    }
    if (await lineChangedSincePosted(finding, headSha, diffBetween))
      resolved.push({ ...finding, evidence: "line-changed" });
    else open.push(finding);
  }
  return { resolved, open, rechecks };
}

/** Whether the line a finding pointed at changed between the commit it was posted on and `headSha`. */
async function lineChangedSincePosted(
  finding: PriorFinding,
  headSha: string,
  diffBetween: DiffBetween,
): Promise<boolean> {
  const diff = await diffBetween(finding.headSha, headSha, finding.file);
  // The old commit is gone (force push). We can't tell, so don't claim it was fixed.
  if (diff === null) return false;
  return lineChanged(parseDiff(diff), finding.file, finding.line);
}

const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

const RESOLVE_THREAD = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          comments: { nodes: { databaseId: number | null }[] };
        }[];
      };
    };
  };
}

/**
 * Marks resolved the threads of `author`'s inline comments whose findings this
 * push resolved, so the conversation agrees with the review that says so.
 * Returns how many threads it resolved.
 */
export async function resolveThreads(
  octokit: Octokit,
  pr: PullRequestRef,
  author: string,
  resolved: ResolvedFinding[],
): Promise<number> {
  if (resolved.length === 0) return 0;
  const keys = new Set(resolved.map((f) => `${findingKey(f)}:${f.headSha}`));
  const comments = await octokit.paginate(
    octokit.rest.pulls.listReviewComments,
    {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: PAGE_SIZE,
    },
  );
  const commentIds = new Set(
    comments
      .filter(
        (c) =>
          postedBy(c, author) &&
          parseFindingMarkers(c.body).some((f) =>
            keys.has(`${findingKey(f)}:${f.headSha}`),
          ),
      )
      .map((c) => c.id),
  );
  if (commentIds.size === 0) return 0;

  let count = 0;
  let after: string | null = null;
  do {
    const page: ReviewThreadsPage = await octokit.graphql(REVIEW_THREADS, {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      after,
    });
    const threads = page.repository.pullRequest.reviewThreads;
    for (const thread of threads.nodes) {
      const first = thread.comments.nodes[0]?.databaseId;
      if (thread.isResolved || typeof first !== "number") continue;
      if (!commentIds.has(first)) continue;
      await octokit.graphql(RESOLVE_THREAD, { threadId: thread.id });
      count += 1;
    }
    after = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (after !== null);
  return count;
}

export function lineChanged(
  files: DiffFile[],
  file: string,
  line: number,
): boolean {
  const entry = files.find((f) => f.oldPath === file || f.path === file);
  if (!entry) return false;
  if (entry.status === "deleted") return true;
  return entry.hunks.some((h) => {
    // A pure insertion has oldLines 0 and does not touch the line itself.
    if (h.oldLines === 0) return false;
    return line >= h.oldStart && line < h.oldStart + h.oldLines;
  });
}
