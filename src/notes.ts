/**
 * The notes that say why a run did not review or investigate: the diff is too
 * large for the budget, or the suite does not pass on the PR commit in the sandbox.
 */

import { diffTokenLimit, estimateTokens, type BudgetLimits } from "./budget.js";
import type { PullRequestDiff } from "./context.js";
import type { TestRun } from "./scratch-tree.js";

const BYTES_PER_KB = 1024;
/** How much of the suite's output, from the end, the baseline note quotes. */
const BASELINE_OUTPUT_CHARS = 3000;

/**
 * The note posted instead of a review when the diff alone would take more
 * than its share of the token budget, or null when it fits. Like a reviewer
 * who asks for smaller pull requests, this declines rather than fails: the
 * review never blocks a merge, and the gate still decides it.
 */
export function tooLargeNote(
  diff: PullRequestDiff,
  limits: BudgetLimits,
): string | null {
  const tokens = estimateTokens(diff.text);
  const limit = diffTokenLimit(limits);
  if (tokens <= limit) return null;
  const kb = Math.round(Buffer.byteLength(diff.text, "utf8") / BYTES_PER_KB);
  return (
    `This diff is about ${String(kb)} KB (≈ ${tokens.toLocaleString("en-US")} tokens), over this project's review limit of ` +
    `${limit.toLocaleString("en-US")} tokens, a quarter of its \`max-tokens\` budget. Split it into smaller pull requests to get a review.`
  );
}

function baselineFailure(run: TestRun): string {
  if (run.timedOut) return "The suite timed out";
  if (run.buildFailed) return "The build failed";
  return "The suite failed";
}

/** The note posted instead of a review when the unchanged PR commit does not pass in the sandbox. */
export function baselineNote(run: TestRun, runUrl: string): string {
  return [
    "### PR Verify: not reviewed",
    "",
    `${baselineFailure(run)} on this commit in the review's sandbox, which has no network and only toolchain variables, so no finding could be verified. The gate runs the suite outside the sandbox and still decides the merge.`,
    "",
    "```",
    run.output.slice(-BASELINE_OUTPUT_CHARS).trimEnd(),
    "```",
    "",
    `[Run record](${runUrl})`,
  ].join("\n");
}
