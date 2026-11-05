/**
 * Posting policy. One review per run with the comment event only; findings
 * on diff lines go inline, the rest into the body; a hidden marker tags
 * everything so a later run can find what was already said.
 */

import type { Octokit } from "./context.js";
import { git } from "./context.js";
import { isCommentable, parseDiff, type DiffFile } from "./diff.js";
import type {
  Finding,
  Patch,
  PriorFinding,
  PullRequestRef,
  ResolvedFinding,
} from "./types.js";
import type { RecheckResult } from "./verify.js";

const MARKER = "pr-verify";
const FINDING_MARKER = new RegExp(
  `<!-- ${MARKER}:finding (\\{.*?\\}) -->`,
  "g",
);
const RESOLVED_MARKER = new RegExp(
  `<!-- ${MARKER}:resolved (\\{.*?\\}) -->`,
  "g",
);
const COMMENT_MARKER = (key: string) => `<!-- ${MARKER}:comment ${key} -->`;
const TEST_SUMMARY = "Test that fails on this commit";
// A diff line starts with a space, +, - or \, so a line opening with ``` can only be the closing fence.
const TEST_BLOCK = new RegExp(
  `<summary>${TEST_SUMMARY}</summary>\\s*\`\`\`diff\\n([\\s\\S]*?)\\n\`\`\``,
  "g",
);

/** The login every comment made with the default GITHUB_TOKEN is posted under. */
export const DEFAULT_TOKEN_LOGIN = "github-actions[bot]";

/**
 * The account this action posts as. Markers are trusted only from it: anyone
 * can comment on a pull request, and a prior finding's test is run on the
 * next push, so a marker from anyone else would be a stranger's code.
 */
export async function postingLogin(octokit: Octokit): Promise<string> {
  try {
    return (await octokit.rest.users.getAuthenticated()).data.login;
  } catch {
    // The default GITHUB_TOKEN cannot read /user.
    return DEFAULT_TOKEN_LOGIN;
  }
}

export function findingMarker(finding: PriorFinding): string {
  return `<!-- ${MARKER}:finding ${JSON.stringify(finding)} -->`;
}

/** Tags an entry under "Resolved by this push" so later runs stop re-checking and re-announcing it. */
export function resolvedMarker(finding: PriorFinding): string {
  const { category, file, line, title, verified, headSha } = finding;
  return `<!-- ${MARKER}:resolved ${JSON.stringify({ category, file, line, title, verified, headSha })} -->`;
}

/** The JSON a marker pattern captured. Its one group takes part in every match. */
function markerJson(match: RegExpMatchArray): string {
  const json = match[1];
  if (json === undefined)
    throw new Error(`marker matched without its JSON: ${match[0]}`);
  return json;
}

function readPrior(json: string): PriorFinding | null {
  try {
    const parsed = JSON.parse(json) as Partial<PriorFinding>;
    if (
      typeof parsed.file === "string" &&
      typeof parsed.line === "number" &&
      typeof parsed.title === "string" &&
      typeof parsed.category === "string" &&
      typeof parsed.headSha === "string"
    ) {
      return {
        file: parsed.file,
        line: parsed.line,
        title: parsed.title,
        category: parsed.category,
        headSha: parsed.headSha,
        verified: parsed.verified === true,
      };
    }
  } catch {
    // A marker someone edited by hand is not our problem; skip it.
  }
  return null;
}

/** A finding read back from a posted comment, with the test that demonstrated it when there was one. */
export interface PostedFinding {
  finding: PriorFinding;
  testPatch: string | null;
}

/**
 * Reads every finding marker in a comment body. A finding's test sits between
 * the previous marker and its own, because renderFinding writes the patches
 * first and the marker last.
 */
export function parsePostedFindings(text: string): PostedFinding[] {
  const out: PostedFinding[] = [];
  let segmentStart = 0;
  for (const match of text.matchAll(FINDING_MARKER)) {
    const segment = text.slice(segmentStart, match.index);
    segmentStart = match.index + match[0].length;
    const finding = readPrior(markerJson(match));
    if (!finding) continue;
    const test = [...segment.matchAll(TEST_BLOCK)].at(-1)?.[1];
    out.push({ finding, testPatch: test === undefined ? null : `${test}\n` });
  }
  return out;
}

export function parseFindingMarkers(text: string): PriorFinding[] {
  return parsePostedFindings(text).map((p) => p.finding);
}

function findingKey(finding: PriorFinding): string {
  return `${finding.file}:${String(finding.line)}:${finding.category}:${finding.title}`;
}

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
      per_page: 100,
    }),
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100,
    }),
  ]);
  const texts = [...reviews, ...comments]
    .filter((c) => c.user?.login === author)
    .map((c) => c.body);

  const resolved = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(RESOLVED_MARKER)) {
      const finding = readPrior(markerJson(match));
      if (finding) resolved.add(`${findingKey(finding)}:${finding.headSha}`);
    }
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
    const diff = await diffBetween(finding.headSha, headSha, finding.file);
    if (diff === null) {
      // The old commit is gone (force push). We can't tell, so don't claim it was fixed.
      open.push(finding);
      continue;
    }
    if (lineChanged(parseDiff(diff), finding.file, finding.line))
      resolved.push({ ...finding, evidence: "line-changed" });
    else open.push(finding);
  }
  return { resolved, open, rechecks };
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

/** True when a new finding says the same thing as one already open on the PR. */
export function isDuplicate(finding: Finding, open: PriorFinding[]): boolean {
  const title = finding.title.trim().toLowerCase();
  return open.some(
    (p) =>
      p.file === finding.file &&
      p.category === finding.category &&
      (p.title.trim().toLowerCase() === title ||
        Math.abs(p.line - finding.line) <= 2),
  );
}

export interface ReviewTrail {
  filesRead: string[];
  tests: { description: string; exitCode: number | null }[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  wallMs: number;
  runUrl: string;
}

export interface ReviewDraft {
  body: string;
  comments: { path: string; line: number; body: string }[];
}

const RESOLVED_BY: Record<ResolvedFinding["evidence"], string> = {
  "test-passes": "its test passes now",
  "line-changed": "the line it pointed at changed",
};

function fenceDiff(diff: string): string {
  return `\`\`\`diff\n${diff.trimEnd()}\n\`\`\``;
}

function renderFinding(
  finding: Finding,
  patches: Patch[],
  headSha: string,
  withLocation: boolean,
): string {
  const prior: PriorFinding = {
    category: finding.category,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    verified: finding.verified,
    headSha,
  };
  const badge = finding.verified
    ? "Verified"
    : `Unverified, ${finding.confidence} confidence`;
  const lines = [`**${finding.title}** · ${finding.category} · ${badge}`];
  if (withLocation) lines.push(`\`${finding.file}:${String(finding.line)}\``);
  lines.push("", finding.explanation);

  const test =
    finding.testPatch !== undefined
      ? patches.find((p) => p.id === finding.testPatch)
      : undefined;
  const fix =
    finding.fixPatch !== undefined
      ? patches.find((p) => p.id === finding.fixPatch)
      : undefined;
  if (test && finding.testPatchVerified) {
    lines.push(
      "",
      `<details><summary>${TEST_SUMMARY}</summary>`,
      "",
      fenceDiff(test.diff),
      "</details>",
    );
  }
  if (fix && finding.fixPatchVerified) {
    lines.push(
      "",
      "<details><summary>Fix that makes it pass</summary>",
      "",
      fenceDiff(fix.diff),
      "</details>",
    );
  }
  lines.push("", findingMarker(prior));
  return lines.join("\n");
}

/**
 * Splits findings into inline comments (diff lines) and body entries (the
 * rest), and writes the body: verified first, unverified, resolved, trail.
 */
export function buildReview(
  findings: Finding[],
  patches: Patch[],
  resolved: ResolvedFinding[],
  diffFiles: DiffFile[],
  headSha: string,
  trail: ReviewTrail,
): ReviewDraft {
  const comments: ReviewDraft["comments"] = [];
  const bodyFindings: Finding[] = [];
  for (const finding of findings) {
    if (isCommentable(diffFiles, finding.file, finding.line)) {
      finding.placement = "inline";
      comments.push({
        path: finding.file,
        line: finding.line,
        body: renderFinding(finding, patches, headSha, false),
      });
    } else {
      finding.placement = "body";
      bodyFindings.push(finding);
    }
  }

  const verified = bodyFindings.filter((f) => f.verified);
  const unverified = bodyFindings.filter((f) => !f.verified);
  const sections: string[] = [];

  const inlineCount = comments.length;
  const summary = [
    `${String(findings.filter((f) => f.verified).length)} verified`,
    `${String(findings.filter((f) => !f.verified).length)} unverified`,
    `${String(resolved.length)} resolved since the last review`,
  ].join(", ");
  sections.push(
    `### PR Verify review\n\n${summary}.${inlineCount > 0 ? ` ${String(inlineCount)} inline.` : ""}`,
  );

  if (verified.length > 0) {
    sections.push(
      `### Verified\n\n${verified.map((f) => renderFinding(f, patches, headSha, true)).join("\n\n---\n\n")}`,
    );
  }
  if (unverified.length > 0) {
    sections.push(
      `### Unverified\n\n${unverified.map((f) => renderFinding(f, patches, headSha, true)).join("\n\n---\n\n")}`,
    );
  }
  if (resolved.length > 0) {
    const entries = resolved.map(
      (r) =>
        `- \`${r.file}:${String(r.line)}\` ${r.title} (${RESOLVED_BY[r.evidence]}) ${resolvedMarker(r)}`,
    );
    sections.push(`### Resolved by this push\n\n${entries.join("\n")}`);
  }

  const trailLines = [
    `Files read: ${trail.filesRead.length > 0 ? trail.filesRead.map((f) => `\`${f}\``).join(", ") : "none"}`,
    `Tests run by the agent: ${
      trail.tests.length > 0
        ? trail.tests
            .map(
              (t) =>
                `${t.description} (exit ${String(t.exitCode ?? "timeout")})`,
            )
            .join("; ")
        : "none"
    }`,
    `Tokens: ${String(trail.inputTokens)} in, ${String(trail.cachedInputTokens)} cached, ${String(trail.outputTokens)} out`,
    `Wall time: ${String(Math.round(trail.wallMs / 1000))}s`,
    `[Run record](${trail.runUrl})`,
  ];
  sections.push(
    `<details><summary>Trail</summary>\n\n${trailLines.map((l) => `- ${l}`).join("\n")}\n\n</details>`,
  );
  sections.push(`<!-- ${MARKER}:review ${headSha} -->`);

  return { body: sections.join("\n\n"), comments };
}

/** Posts the review with the comment event. Never approve, never request changes. */
export async function postReview(
  octokit: Octokit,
  pr: PullRequestRef,
  draft: ReviewDraft,
): Promise<number> {
  const response = await octokit.rest.pulls.createReview({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    commit_id: pr.headSha,
    event: "COMMENT",
    body: draft.body,
    comments: draft.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT" as const,
      body: c.body,
    })),
  });
  return response.data.id;
}

async function findComment(
  octokit: Octokit,
  pr: PullRequestRef,
  marker: string,
) {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    per_page: 100,
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
