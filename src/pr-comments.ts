/**
 * The PR comments this action keeps one of per key, such as the red-gate
 * verdict and the too-large note. A hidden marker names each one, so a later
 * run updates or deletes it instead of posting another.
 */

import { PAGE_SIZE, type Octokit } from "./claude-context.js";
import { COMMENT_MARKER } from "./comment-markers.js";
import type { PullRequestRef } from "./types.js";

async function findComment(
  octokit: Octokit,
  pr: PullRequestRef,
  marker: string,
) {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    per_page: PAGE_SIZE,
  });
  return existing.find((c) => (c.body ?? "").includes(marker));
}

/** Creates or updates the single PR comment identified by `key`. Used for red-gate verdicts and the too-large note. */
export async function upsertComment(
  octokit: Octokit,
  pr: PullRequestRef,
  key: string,
  body: string,
): Promise<number> {
  const marker = COMMENT_MARKER(key);
  const full = `${body}\n\n${marker}`;
  const mine = await findComment(octokit, pr, marker);
  if (mine) {
    await octokit.rest.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: mine.id,
      body: full,
    });
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

/** Updates the PR comment identified by `key`, if there is one, and never creates it. */
export async function updateComment(
  octokit: Octokit,
  pr: PullRequestRef,
  key: string,
  body: string,
): Promise<void> {
  const marker = COMMENT_MARKER(key);
  const mine = await findComment(octokit, pr, marker);
  if (mine) {
    await octokit.rest.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: mine.id,
      body: `${body}\n\n${marker}`,
    });
  }
}

/** Deletes the PR comment identified by `key`, if there is one. */
export async function deleteComment(
  octokit: Octokit,
  pr: PullRequestRef,
  key: string,
): Promise<void> {
  const mine = await findComment(octokit, pr, COMMENT_MARKER(key));
  if (mine)
    await octokit.rest.issues.deleteComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: mine.id,
    });
}
