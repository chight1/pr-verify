/**
 * Posting policy. One review per run with the comment event only; findings
 * on diff lines go inline, the rest into the body; a hidden marker tags
 * everything so a later run can find what was already said.
 */

import { MS_PER_SECOND } from "./budget.js";
import type { Octokit } from "./context.js";
import { isCommentable, type DiffFile } from "./diff.js";
import {
  findingMarker,
  resolvedMarker,
  reviewMarker,
  TEST_SUMMARY,
} from "./markers.js";
import type {
  Finding,
  Patch,
  PriorFinding,
  PullRequestRef,
  ResolvedFinding,
} from "./types.js";

/** A finding this many lines or fewer from an open one in the same file and category repeats it. */
const DUPLICATE_LINE_DISTANCE = 2;

/** True when a new finding says the same thing as one already open on the PR. */
export function isDuplicate(finding: Finding, open: PriorFinding[]): boolean {
  const title = finding.title.trim().toLowerCase();
  return open.some(
    (p) =>
      p.file === finding.file &&
      p.category === finding.category &&
      (p.title.trim().toLowerCase() === title ||
        Math.abs(p.line - finding.line) <= DUPLICATE_LINE_DISTANCE),
  );
}

/** The commit a review is posted on, and its diff, which decides which findings go inline. */
interface ReviewedCommit {
  headSha: string;
  diffFiles: DiffFile[];
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

/** The body's opening: how many findings of each kind, and how many went inline. */
function summarySection(
  findings: Finding[],
  resolved: ResolvedFinding[],
  inlineCount: number,
): string {
  const summary = [
    `${String(findings.filter((f) => f.verified).length)} verified`,
    `${String(findings.filter((f) => !f.verified).length)} unverified`,
    `${String(resolved.length)} resolved since the last review`,
  ].join(", ");
  const inline = inlineCount > 0 ? ` ${String(inlineCount)} inline.` : "";
  return `### PR Verify review\n\n${summary}.${inline}`;
}

function resolvedSection(resolved: ResolvedFinding[]): string {
  const entries = resolved.map(
    (r) =>
      `- \`${r.file}:${String(r.line)}\` ${r.title} (${RESOLVED_BY[r.evidence]}) ${resolvedMarker(r)}`,
  );
  return `### Resolved by this push\n\n${entries.join("\n")}`;
}

/** The collapsed footer: what the agent read and ran, and what the run cost. */
function trailSection(trail: ReviewTrail): string {
  const filesRead = trail.filesRead.map((f) => `\`${f}\``).join(", ");
  const trailLines = [
    `Files read: ${trail.filesRead.length > 0 ? filesRead : "none"}`,
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
    `Wall time: ${String(Math.round(trail.wallMs / MS_PER_SECOND))}s`,
    `[Run record](${trail.runUrl})`,
  ];
  const trailList = trailLines.map((l) => `- ${l}`).join("\n");
  return `<details><summary>Trail</summary>\n\n${trailList}\n\n</details>`;
}

/**
 * Splits findings into inline comments (diff lines) and body entries (the
 * rest), and writes the body: verified first, unverified, resolved, trail.
 */
export function buildReview(
  findings: Finding[],
  patches: Patch[],
  resolved: ResolvedFinding[],
  commit: ReviewedCommit,
  trail: ReviewTrail,
): ReviewDraft {
  const { headSha } = commit;
  const comments: ReviewDraft["comments"] = [];
  const bodyFindings: Finding[] = [];
  for (const finding of findings) {
    if (isCommentable(commit.diffFiles, finding.file, finding.line)) {
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
  const sections = [summarySection(findings, resolved, comments.length)];

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
  if (resolved.length > 0) sections.push(resolvedSection(resolved));

  sections.push(trailSection(trail));
  sections.push(reviewMarker(headSha));

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
