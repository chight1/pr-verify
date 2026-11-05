import { describe, expect, it, vi } from "vitest";
import {
  deleteComment,
  updateComment,
  upsertComment,
} from "../src/pr-comments.js";
import { PR } from "./review-fixtures.js";

describe("upsertComment", () => {
  function octokitWith(existing: { id: number; body: string }[]) {
    const updateComment = vi.fn(() => Promise.resolve({}));
    const createComment = vi.fn(() => Promise.resolve({ data: { id: 500 } }));
    const octokit = {
      paginate: vi.fn(() => Promise.resolve(existing)),
      rest: { issues: { listComments: {}, updateComment, createComment } },
    } as never;
    return { octokit, updateComment, createComment };
  }

  it("updates the existing marked comment in place", async () => {
    const { octokit, updateComment, createComment } = octokitWith([
      { id: 1, body: "unrelated" },
      { id: 2, body: "old\n\n<!-- pr-verify:comment red-gate -->" },
    ]);
    const id = await upsertComment(octokit, PR, "red-gate", "new body");
    expect(id).toBe(2);
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 2,
        body: "new body\n\n<!-- pr-verify:comment red-gate -->",
      }),
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it("creates the comment when none is marked", async () => {
    const { octokit, updateComment, createComment } = octokitWith([
      { id: 1, body: "unrelated" },
    ]);
    const id = await upsertComment(octokit, PR, "red-gate", "body");
    expect(id).toBe(500);
    expect(createComment).toHaveBeenCalledOnce();
    expect(updateComment).not.toHaveBeenCalled();
  });
});

describe("updateComment", () => {
  function octokitWith(existing: { id: number; body: string }[]) {
    const update = vi.fn(() => Promise.resolve({}));
    const create = vi.fn(() => Promise.resolve({ data: { id: 500 } }));
    const octokit = {
      paginate: vi.fn(() => Promise.resolve(existing)),
      rest: {
        issues: {
          listComments: {},
          updateComment: update,
          createComment: create,
        },
      },
    } as never;
    return { octokit, update, create };
  }

  it("rewrites the marked comment and keeps its marker", async () => {
    const { octokit, update } = octokitWith([
      { id: 2, body: "failed\n\n<!-- pr-verify:comment red-gate -->" },
    ]);
    await updateComment(octokit, PR, "red-gate", "passes");
    expect(update).toHaveBeenCalledExactlyOnceWith({
      owner: "o",
      repo: "r",
      comment_id: 2,
      body: "passes\n\n<!-- pr-verify:comment red-gate -->",
    });
  });

  it("posts nothing when no comment is marked", async () => {
    const { octokit, update, create } = octokitWith([
      { id: 1, body: "unrelated" },
    ]);
    await updateComment(octokit, PR, "red-gate", "passes");
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("deleteComment", () => {
  function octokitWith(existing: { id: number; body: string }[]) {
    const remove = vi.fn(() => Promise.resolve({}));
    const octokit = {
      paginate: vi.fn(() => Promise.resolve(existing)),
      rest: { issues: { listComments: {}, deleteComment: remove } },
    } as never;
    return { octokit, remove };
  }

  it("deletes only the comment with the matching marker, and is a no-op without one", async () => {
    const found = octokitWith([
      { id: 1, body: "x\n\n<!-- pr-verify:comment red-gate -->" },
      { id: 2, body: "x\n\n<!-- pr-verify:comment too-large -->" },
    ]);
    await deleteComment(found.octokit, PR, "too-large");
    expect(found.remove).toHaveBeenCalledExactlyOnceWith({
      owner: "o",
      repo: "r",
      comment_id: 2,
    });

    const none = octokitWith([{ id: 1, body: "unrelated" }]);
    await deleteComment(none.octokit, PR, "too-large");
    expect(none.remove).not.toHaveBeenCalled();
  });
});
