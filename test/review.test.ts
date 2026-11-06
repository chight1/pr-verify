import { assert, describe, expect, it, vi } from "vitest";
import { parseDiff } from "../src/diff.js";
import { buildReview, isDuplicate, postReview } from "../src/review.js";
import type { Patch } from "../src/types.js";
import { finding, PR, prior, TRAIL } from "./review-fixtures.js";

describe("isDuplicate", () => {
  it("matches on title or on a nearby line in the same file and category", () => {
    expect(
      isDuplicate(finding({ title: "quantity ignored", line: 90 }), [prior]),
    ).toBe(true);
    expect(
      isDuplicate(finding({ title: "Different", line: 13 }), [prior]),
    ).toBe(true);
    expect(
      isDuplicate(finding({ title: "Different", line: 50 }), [prior]),
    ).toBe(false);
    expect(
      isDuplicate(finding({ category: "security", line: 12 }), [prior]),
    ).toBe(false);
  });
});

describe("buildReview", () => {
  const diffFiles = parseDiff(
    `diff --git a/src/order.ts b/src/order.ts\nindex 1..2 100644\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -10,3 +10,4 @@\n a\n-b\n+b2\n+c\n d\n`,
  );
  const patches: Patch[] = [
    {
      id: 1,
      kind: "test",
      description: "failing test",
      diff: "diff --git a/test/x.test.ts b/test/x.test.ts\n+test",
    },
    {
      id: 2,
      kind: "fix",
      description: "fix",
      diff: "diff --git a/src/order.ts b/src/order.ts\n-b\n+c",
    },
  ];

  it("puts diff-line findings inline and the rest in the body, verified first", () => {
    const inline = finding({
      line: 12,
      testPatch: 1,
      fixPatch: 2,
      fixPatchVerified: true,
    });
    const outside = finding({
      line: 80,
      title: "Out of diff",
      verified: false,
      testPatchVerified: null,
      confidence: "medium",
    });
    const draft = buildReview(
      [outside, inline],
      patches,
      [{ ...prior, evidence: "test-passes" }],
      { headSha: "head2", diffFiles },
      TRAIL,
    );

    expect(draft.comments).toHaveLength(1);
    expect(draft.comments[0]).toMatchObject({ path: "src/order.ts", line: 12 });
    expect(inline.placement).toBe("inline");
    expect(outside.placement).toBe("body");

    const [comment] = draft.comments;
    assert.isDefined(comment);
    expect(comment.body).toContain("Test that fails on this commit");
    expect(comment.body).toContain("Fix that makes it pass");
    expect(comment.body).toContain("<!-- pr-verify:finding ");

    expect(draft.body).toContain("1 verified, 1 unverified, 1 resolved");
    expect(draft.body).toContain("### Unverified");
    expect(draft.body).toContain("`src/order.ts:80`");
    expect(draft.body).toContain("### Resolved by this push");
    expect(draft.body).toContain(
      "Quantity ignored (its test passes now) <!-- pr-verify:resolved ",
    );
    expect(draft.body).toContain("Tokens: 1000 in, 500 cached, 200 out");
    expect(draft.body).toContain("<!-- pr-verify:review head2 -->");
    expect(draft.body).not.toContain("### Verified");
  });

  it("never embeds a patch that did not verify", () => {
    const f = finding({
      line: 12,
      verified: false,
      testPatchVerified: false,
      testPatch: 1,
    });
    const draft = buildReview(
      [f],
      patches,
      [],
      { headSha: "head2", diffFiles },
      TRAIL,
    );
    const [comment] = draft.comments;
    assert.isDefined(comment);
    expect(comment.body).not.toContain("Test that fails");
    expect(comment.body).toContain("Unverified, high confidence");
  });
});

describe("postReview", () => {
  it("posts one review with the comment event and right-side inline comments", async () => {
    const createReview = vi.fn(() => Promise.resolve({ data: { id: 99 } }));
    const octokit = { rest: { pulls: { createReview } } } as never;
    const id = await postReview(octokit, PR, {
      body: "b",
      comments: [{ path: "src/a.ts", line: 3, body: "c" }],
    });
    expect(id).toBe(99);
    expect(createReview).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      commit_id: "head2",
      event: "COMMENT",
      body: "b",
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "c" }],
    });
  });
});
