/**
 * Fixtures the review, marker and prior-finding tests share: the pull
 * request, a finding an earlier run posted, a trail, and a finding builder.
 */

import type { ReviewTrail } from "../src/post-review.js";
import type { Finding, PriorFinding, PullRequestRef } from "../src/types.js";

export const PR: PullRequestRef = {
  owner: "o",
  repo: "r",
  number: 7,
  baseSha: "base",
  headSha: "head2",
};

export const prior: PriorFinding = {
  category: "bug",
  file: "src/order.ts",
  line: 12,
  title: "Quantity ignored",
  verified: true,
  headSha: "head1",
};

export const TRAIL: ReviewTrail = {
  filesRead: ["src/order.ts"],
  tests: [{ description: "run 2", exitCode: 1 }],
  inputTokens: 1000,
  outputTokens: 200,
  cachedInputTokens: 500,
  wallMs: 42_000,
  runUrl: "https://example.test/run/1",
};

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "bug",
    confidence: "high",
    file: "src/order.ts",
    line: 13,
    title: "Discount applied twice",
    explanation: "Line 13 subtracts the discount after total() already did.",
    verified: true,
    testPatchVerified: true,
    fixPatchVerified: null,
    placement: "body",
    ...overrides,
  };
}
