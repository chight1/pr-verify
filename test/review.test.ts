import { describe, expect, it, vi } from 'vitest';
import { parseDiff } from '../src/diff.js';
import {
  buildReview,
  findingMarker,
  isDuplicate,
  lineChanged,
  parseFindingMarkers,
  postReview,
  resolvePriorFindings,
  upsertComment,
  type ReviewTrail,
} from '../src/review.js';
import type { Finding, Patch, PriorFinding, PullRequestRef } from '../src/types.js';

const PR: PullRequestRef = { owner: 'o', repo: 'r', number: 7, baseSha: 'base', headSha: 'head2' };

const prior: PriorFinding = { category: 'bug', file: 'src/order.ts', line: 12, title: 'Quantity ignored', verified: true, headSha: 'head1' };

const TRAIL: ReviewTrail = {
  filesRead: ['src/order.ts'],
  tests: [{ description: 'run 2', exitCode: 1 }],
  inputTokens: 1000,
  outputTokens: 200,
  cachedInputTokens: 500,
  wallMs: 42_000,
  runUrl: 'https://example.test/run/1',
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: 'bug',
    confidence: 'high',
    file: 'src/order.ts',
    line: 13,
    title: 'Discount applied twice',
    explanation: 'Line 13 subtracts the discount after total() already did.',
    verified: true,
    testPatchVerified: true,
    fixPatchVerified: null,
    placement: 'body',
    ...overrides,
  };
}

describe('finding markers', () => {
  it('round-trips through a comment body', () => {
    const body = `**Quantity ignored**\n\nsome text\n\n${findingMarker(prior)}`;
    expect(parseFindingMarkers(body)).toEqual([prior]);
  });

  it('ignores malformed or foreign markers', () => {
    expect(parseFindingMarkers('<!-- pr-verify:finding {not json} --> <!-- other:finding {"a":1} -->')).toEqual([]);
    expect(parseFindingMarkers('<!-- pr-verify:finding {"file":"x"} -->')).toEqual([]);
  });
});

describe('lineChanged', () => {
  const files = parseDiff(`diff --git a/src/order.ts b/src/order.ts\nindex 1..2 100644\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -12,1 +12,1 @@\n-old\n+new\n@@ -30,0 +31,2 @@\n+inserted\n+inserted\n`);

  it('is true when the old line sits inside a changed range', () => {
    expect(lineChanged(files, 'src/order.ts', 12)).toBe(true);
  });

  it('is false for untouched lines and for pure insertions nearby', () => {
    expect(lineChanged(files, 'src/order.ts', 13)).toBe(false);
    expect(lineChanged(files, 'src/order.ts', 30)).toBe(false);
    expect(lineChanged(files, 'other.ts', 12)).toBe(false);
  });

  it('is true when the file was deleted', () => {
    const deleted = parseDiff(`diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n`);
    expect(lineChanged(deleted, 'gone.ts', 1)).toBe(true);
  });
});

describe('resolvePriorFindings', () => {
  it('splits prior findings by whether their lines changed, using git only', async () => {
    const changed = { ...prior, line: 12 };
    const untouched = { ...prior, line: 40, title: 'Other' };
    const samePush = { ...prior, headSha: 'head2', title: 'Same push' };
    const diffBetween = vi.fn(async () => `diff --git a/src/order.ts b/src/order.ts\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -12,1 +12,1 @@\n-a\n+b\n`);

    const result = await resolvePriorFindings([changed, untouched, samePush], 'head2', '.', diffBetween);
    expect(result.resolved).toEqual([changed]);
    expect(result.open).toEqual([untouched, samePush]);
    expect(diffBetween).toHaveBeenCalledTimes(2);
    expect(diffBetween).toHaveBeenCalledWith('head1', 'head2', 'src/order.ts');
  });

  it('keeps a finding open when the old commit is unavailable', async () => {
    const result = await resolvePriorFindings([prior], 'head2', '.', async () => null);
    expect(result.open).toEqual([prior]);
    expect(result.resolved).toEqual([]);
  });
});

describe('isDuplicate', () => {
  it('matches on title or on a nearby line in the same file and category', () => {
    expect(isDuplicate(finding({ title: 'quantity ignored', line: 90 }), [prior])).toBe(true);
    expect(isDuplicate(finding({ title: 'Different', line: 13 }), [prior])).toBe(true);
    expect(isDuplicate(finding({ title: 'Different', line: 50 }), [prior])).toBe(false);
    expect(isDuplicate(finding({ category: 'security', line: 12 }), [prior])).toBe(false);
  });
});

describe('buildReview', () => {
  const diffFiles = parseDiff(`diff --git a/src/order.ts b/src/order.ts\nindex 1..2 100644\n--- a/src/order.ts\n+++ b/src/order.ts\n@@ -10,3 +10,4 @@\n a\n-b\n+b2\n+c\n d\n`);
  const patches: Patch[] = [
    { id: 1, kind: 'test', description: 'failing test', diff: 'diff --git a/test/x.test.ts b/test/x.test.ts\n+test' },
    { id: 2, kind: 'fix', description: 'fix', diff: 'diff --git a/src/order.ts b/src/order.ts\n-b\n+c' },
  ];

  it('puts diff-line findings inline and the rest in the body, verified first', () => {
    const inline = finding({ line: 12, testPatch: 1, fixPatch: 2, fixPatchVerified: true });
    const outside = finding({ line: 80, title: 'Out of diff', verified: false, testPatchVerified: null, confidence: 'medium' });
    const draft = buildReview([outside, inline], patches, [prior], diffFiles, 'head2', TRAIL);

    expect(draft.comments).toHaveLength(1);
    expect(draft.comments[0]).toMatchObject({ path: 'src/order.ts', line: 12 });
    expect(inline.placement).toBe('inline');
    expect(outside.placement).toBe('body');

    expect(draft.comments[0]!.body).toContain('Test that fails on this commit');
    expect(draft.comments[0]!.body).toContain('Fix that makes it pass');
    expect(draft.comments[0]!.body).toContain('<!-- pr-verify:finding ');

    expect(draft.body).toContain('1 verified, 1 unverified, 1 resolved');
    expect(draft.body).toContain('### Unverified');
    expect(draft.body).toContain('`src/order.ts:80`');
    expect(draft.body).toContain('### Resolved by this push');
    expect(draft.body).toContain('Quantity ignored');
    expect(draft.body).toContain('Tokens: 1000 in, 500 cached, 200 out');
    expect(draft.body).toContain('<!-- pr-verify:review head2 -->');
    expect(draft.body).not.toContain('### Verified');
  });

  it('never embeds a patch that did not verify', () => {
    const f = finding({ line: 12, verified: false, testPatchVerified: false, testPatch: 1 });
    const draft = buildReview([f], patches, [], diffFiles, 'head2', TRAIL);
    expect(draft.comments[0]!.body).not.toContain('Test that fails');
    expect(draft.comments[0]!.body).toContain('Unverified, high confidence');
  });
});

describe('postReview', () => {
  it('posts one review with the comment event and right-side inline comments', async () => {
    const createReview = vi.fn(async () => ({ data: { id: 99 } }));
    const octokit = { rest: { pulls: { createReview } } } as never;
    const id = await postReview(octokit, PR, { body: 'b', comments: [{ path: 'src/a.ts', line: 3, body: 'c' }] });
    expect(id).toBe(99);
    expect(createReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      commit_id: 'head2',
      event: 'COMMENT',
      body: 'b',
      comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'c' }],
    });
  });
});

describe('upsertComment', () => {
  function octokitWith(existing: Array<{ id: number; body: string }>) {
    const updateComment = vi.fn(async () => ({}));
    const createComment = vi.fn(async () => ({ data: { id: 500 } }));
    const octokit = {
      paginate: vi.fn(async () => existing),
      rest: { issues: { listComments: {}, updateComment, createComment } },
    } as never;
    return { octokit, updateComment, createComment };
  }

  it('updates the existing marked comment in place', async () => {
    const { octokit, updateComment, createComment } = octokitWith([
      { id: 1, body: 'unrelated' },
      { id: 2, body: 'old\n\n<!-- pr-verify:comment red-gate -->' },
    ]);
    const id = await upsertComment(octokit, PR, 'red-gate', 'new body');
    expect(id).toBe(2);
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2, body: 'new body\n\n<!-- pr-verify:comment red-gate -->' }));
    expect(createComment).not.toHaveBeenCalled();
  });

  it('creates the comment when none is marked', async () => {
    const { octokit, updateComment, createComment } = octokitWith([{ id: 1, body: 'unrelated' }]);
    const id = await upsertComment(octokit, PR, 'red-gate', 'body');
    expect(id).toBe(500);
    expect(createComment).toHaveBeenCalledOnce();
    expect(updateComment).not.toHaveBeenCalled();
  });
});
