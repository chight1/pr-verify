import { describe, expect, it, vi } from "vitest";
import { parseDiff } from "../src/diff.js";
import {
  findingMarker,
  parsePostedFindings,
  type PostedFinding,
} from "../src/comment-markers.js";
import {
  fetchPriorFindings,
  lineChanged,
  MAX_RECHECKS,
  resolvePriorFindings,
  resolveThreads,
} from "../src/prior-findings.js";
import { buildReview } from "../src/post-review.js";
import type { Patch, PriorFinding } from "../src/types.js";
import { finding, PR, prior, TRAIL } from "./review-fixtures.js";

describe("lineChanged", () => {
  const files = parseDiff(
    `diff --git a/src/order.ts b/src/order.ts\nindex 1..2 100644\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -12,1 +12,1 @@\n-old\n+new\n@@ -30,0 +31,2 @@\n+inserted\n+inserted\n`,
  );

  it("is true when the old line sits inside a changed range", () => {
    expect(lineChanged(files, "src/order.ts", 12)).toBe(true);
  });

  it("is false for untouched lines and for pure insertions nearby", () => {
    expect(lineChanged(files, "src/order.ts", 13)).toBe(false);
    expect(lineChanged(files, "src/order.ts", 30)).toBe(false);
    expect(lineChanged(files, "other.ts", 12)).toBe(false);
  });

  it("is true when the file was deleted", () => {
    const deleted = parseDiff(
      `diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n`,
    );
    expect(lineChanged(deleted, "gone.ts", 1)).toBe(true);
  });
});

describe("resolvePriorFindings", () => {
  const LINE_12_CHANGED = `diff --git a/src/order.ts b/src/order.ts\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -12,1 +12,1 @@\n-a\n+b\n`;
  const untested = (f: PriorFinding): PostedFinding => ({
    finding: f,
    testPatch: null,
  });
  const tested = (
    f: PriorFinding,
    testPatch = "test patch",
  ): PostedFinding => ({ finding: f, testPatch });
  const noRecheck = vi.fn(() => Promise.resolve("passes" as const));

  it("without a test, splits prior findings by whether their lines changed, using git only", async () => {
    const changed = { ...prior, line: 12 };
    const untouched = { ...prior, line: 40, title: "Other" };
    const samePush = { ...prior, headSha: "head2", title: "Same push" };
    const diffBetween = vi.fn(() => Promise.resolve(LINE_12_CHANGED));

    const result = await resolvePriorFindings(
      [changed, untouched, samePush].map(untested),
      "head2",
      noRecheck,
      diffBetween,
    );
    expect(result.resolved).toEqual([{ ...changed, evidence: "line-changed" }]);
    expect(result.open).toEqual([untouched, samePush]);
    expect(diffBetween).toHaveBeenCalledTimes(2);
    expect(diffBetween).toHaveBeenCalledWith("head1", "head2", "src/order.ts");
    expect(noRecheck).not.toHaveBeenCalled();
  });

  it("keeps a finding open when the old commit is unavailable", async () => {
    const result = await resolvePriorFindings(
      [untested(prior)],
      "head2",
      noRecheck,
      () => Promise.resolve(null),
    );
    expect(result.open).toEqual([prior]);
    expect(result.resolved).toEqual([]);
  });

  it("resolves a finding whose test passes now, even though its line never changed", async () => {
    const untouched = { ...prior, line: 40 };
    const recheck = vi.fn(() => Promise.resolve("passes" as const));
    const result = await resolvePriorFindings(
      [tested(untouched, "the test")],
      "head2",
      recheck,
      () => Promise.resolve(LINE_12_CHANGED),
    );
    expect(recheck).toHaveBeenCalledWith("the test");
    expect(result).toEqual({
      resolved: [{ ...untouched, evidence: "test-passes" }],
      open: [],
      rechecks: 1,
    });
  });

  it("keeps a finding open while its test still fails, even though its line changed", async () => {
    const result = await resolvePriorFindings(
      [tested(prior)],
      "head2",
      () => Promise.resolve("fails"),
      () => Promise.resolve(LINE_12_CHANGED),
    );
    expect(result.resolved).toEqual([]);
    expect(result.open).toEqual([prior]);
  });

  it("falls back to the line when the test no longer fits the commit", async () => {
    const result = await resolvePriorFindings(
      [tested(prior)],
      "head2",
      () => Promise.resolve("unusable"),
      () => Promise.resolve(LINE_12_CHANGED),
    );
    expect(result.resolved).toEqual([{ ...prior, evidence: "line-changed" }]);
  });

  it(`re-checks at most ${String(MAX_RECHECKS)} findings and does not re-check one posted on this head`, async () => {
    const many = Array.from({ length: MAX_RECHECKS + 2 }, (_, i) =>
      tested({ ...prior, line: 100 + i, title: `t${String(i)}` }),
    );
    const samePush = tested({ ...prior, headSha: "head2", title: "Same push" });
    const recheck = vi.fn(() => Promise.resolve("passes" as const));
    const result = await resolvePriorFindings(
      [samePush, ...many],
      "head2",
      recheck,
      () => Promise.resolve(LINE_12_CHANGED),
    );
    expect(recheck).toHaveBeenCalledTimes(MAX_RECHECKS);
    expect(result.rechecks).toBe(MAX_RECHECKS);
    expect(result.resolved).toHaveLength(MAX_RECHECKS);
    expect(result.open).toHaveLength(3);
  });
});

describe("reading findings back from posted comments", () => {
  const diffFiles = parseDiff(
    `diff --git a/src/order.ts b/src/order.ts\nindex 1..2 100644\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -10,3 +10,4 @@\n a\n-b\n+b2\n+c\n d\n`,
  );
  const testDiff =
    "diff --git a/test/x.test.ts b/test/x.test.ts\n--- a/test/x.test.ts\n+++ b/test/x.test.ts\n@@ -1,1 +1,2 @@\n test('a', () => {});\n+test('b', () => {});\n";
  const patches: Patch[] = [
    { id: 1, kind: "test", description: "failing test", diff: testDiff },
    {
      id: 2,
      kind: "fix",
      description: "fix",
      diff: "diff --git a/src/order.ts b/src/order.ts\n-b\n+c",
    },
  ];

  it("recovers the exact test a verified finding was posted with, and none for one without", () => {
    const withTest = finding({
      line: 80,
      title: "Tested",
      testPatch: 1,
      fixPatch: 2,
      fixPatchVerified: true,
    });
    const without = finding({
      line: 81,
      title: "Untested",
      verified: false,
      testPatchVerified: null,
      confidence: "medium",
    });
    const draft = buildReview(
      [withTest, without],
      patches,
      [],
      { headSha: "head2", diffFiles },
      TRAIL,
    );

    expect(parsePostedFindings(draft.body)).toEqual([
      {
        finding: {
          category: "bug",
          file: "src/order.ts",
          line: 80,
          title: "Tested",
          verified: true,
          headSha: "head2",
        },
        testPatch: testDiff,
      },
      {
        finding: {
          category: "bug",
          file: "src/order.ts",
          line: 81,
          title: "Untested",
          verified: false,
          headSha: "head2",
        },
        testPatch: null,
      },
    ]);
  });

  function octokitWith(
    reviews: { login: string; body: string }[],
    comments: { login: string; body: string }[] = [],
  ) {
    const listReviews = Symbol("listReviews");
    const listReviewComments = Symbol("listReviewComments");
    const toApi = (items: { login: string; body: string }[]) =>
      items.map((i) => ({ user: { login: i.login }, body: i.body }));
    const paginate = vi.fn((method: symbol) =>
      Promise.resolve(
        method === listReviews ? toApi(reviews) : toApi(comments),
      ),
    );
    return {
      paginate,
      rest: { pulls: { listReviews, listReviewComments } },
    } as never;
  }

  it("trusts markers only from the account the action posts as", async () => {
    const mine = { login: "github-actions[bot]", body: findingMarker(prior) };
    const forged = {
      login: "stranger",
      body: findingMarker({ ...prior, title: "Forged" }),
    };
    const found = await fetchPriorFindings(
      octokitWith([forged], [mine]),
      PR,
      "github-actions[bot]",
    );
    expect(found.map((p) => p.finding.title)).toEqual(["Quantity ignored"]);
  });

  it("skips a finding an earlier review already reported resolved", async () => {
    const reviews = [
      { login: "bot", body: findingMarker(prior) },
      {
        login: "bot",
        body: buildReview(
          [],
          patches,
          [{ ...prior, evidence: "test-passes" }],
          { headSha: "head2", diffFiles },
          TRAIL,
        ).body,
      },
    ];
    expect(await fetchPriorFindings(octokitWith(reviews), PR, "bot")).toEqual(
      [],
    );
  });
});

describe("resolveThreads", () => {
  const resolved = { ...prior, evidence: "line-changed" as const };
  const thread = (id: string, commentId: number, isResolved = false) => ({
    id,
    isResolved,
    comments: { nodes: [{ databaseId: commentId }] },
  });

  function octokitWith(
    comments: { id: number; login: string; body: string }[],
    threads: ReturnType<typeof thread>[],
  ) {
    const resolvedIds: string[] = [];
    const graphql = vi.fn((query: string, vars: Record<string, unknown>) => {
      if (query.includes("resolveReviewThread")) {
        resolvedIds.push(String(vars.threadId));
        return Promise.resolve({});
      }
      return Promise.resolve({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: threads,
            },
          },
        },
      });
    });
    const octokit = {
      graphql,
      paginate: () =>
        Promise.resolve(
          comments.map((c) => ({
            id: c.id,
            user: { login: c.login },
            body: c.body,
          })),
        ),
      rest: { pulls: { listReviewComments: {} } },
    } as never;
    return { octokit, graphql, resolvedIds };
  }

  it("resolves the open thread of the action's comment on a resolved finding", async () => {
    const { octokit, resolvedIds } = octokitWith(
      [
        { id: 1, login: "bot", body: findingMarker(prior) },
        {
          id: 2,
          login: "bot",
          body: findingMarker({ ...prior, title: "Still open" }),
        },
        { id: 3, login: "stranger", body: findingMarker(prior) },
        { id: 4, login: "bot", body: findingMarker(prior) },
      ],
      [
        thread("T1", 1),
        thread("T2", 2),
        thread("T3", 3),
        thread("T4", 4, true),
      ],
    );
    expect(await resolveThreads(octokit, PR, "bot", [resolved])).toBe(1);
    expect(resolvedIds).toEqual(["T1"]);
  });

  it("makes no API call when nothing was resolved", async () => {
    const { octokit, graphql } = octokitWith([], []);
    expect(await resolveThreads(octokit, PR, "bot", [])).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });
});
