/**
 * The hidden markers in everything this action posts, and reading them back.
 * A finding's marker carries what a later run needs to recognise it, and
 * markers are trusted only from the account this action posts as.
 */

import type { Octokit } from "./context.js";
import type { PriorFinding } from "./types.js";

const MARKER = "pr-verify";
const FINDING_MARKER = new RegExp(
  `<!-- ${MARKER}:finding (\\{.*?\\}) -->`,
  "g",
);
const RESOLVED_MARKER = new RegExp(
  `<!-- ${MARKER}:resolved (\\{.*?\\}) -->`,
  "g",
);
export const COMMENT_MARKER = (key: string) =>
  `<!-- ${MARKER}:comment ${key} -->`;
export const TEST_SUMMARY = "Test that fails on this commit";
// A diff line starts with a space, +, - or \, so a line opening with ``` can only be the closing fence.
const TEST_BLOCK = new RegExp(
  `<summary>${TEST_SUMMARY}</summary>\\s*\`\`\`diff\\n([\\s\\S]*?)\\n\`\`\``,
  "g",
);

/** The login every comment made with the default GITHUB_TOKEN is posted under. */
export const DEFAULT_TOKEN_LOGIN = "github-actions[bot]";

/**
 * Whether `author` posted a comment. GitHub can return a comment with no user,
 * though some versions of Octokit's types say otherwise.
 */
export function postedBy(
  comment: { user: { login: string } | null },
  author: string,
): boolean {
  return comment.user?.login === author;
}

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

/** Ends a review body with the commit it reviewed. */
export function reviewMarker(headSha: string): string {
  return `<!-- ${MARKER}:review ${headSha} -->`;
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

export function findingKey(finding: PriorFinding): string {
  return `${finding.file}:${String(finding.line)}:${finding.category}:${finding.title}`;
}

/** Every finding a comment body reports resolved, from the markers resolvedMarker writes. */
export function parseResolvedMarkers(text: string): PriorFinding[] {
  const out: PriorFinding[] = [];
  for (const match of text.matchAll(RESOLVED_MARKER)) {
    const finding = readPrior(markerJson(match));
    if (finding) out.push(finding);
  }
  return out;
}
