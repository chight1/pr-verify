import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_LOGIN,
  findingMarker,
  parseFindingMarkers,
  postedBy,
  postingLogin,
} from "../src/markers.js";
import { prior } from "./review-fixtures.js";

describe("finding markers", () => {
  it("round-trips through a comment body", () => {
    const body = `**Quantity ignored**\n\nsome text\n\n${findingMarker(prior)}`;
    expect(parseFindingMarkers(body)).toEqual([prior]);
  });

  it("ignores malformed or foreign markers", () => {
    expect(
      parseFindingMarkers(
        '<!-- pr-verify:finding {not json} --> <!-- other:finding {"a":1} -->',
      ),
    ).toEqual([]);
    expect(
      parseFindingMarkers('<!-- pr-verify:finding {"file":"x"} -->'),
    ).toEqual([]);
  });
});

describe("postedBy", () => {
  it("matches the author, and is false for a comment with no user", () => {
    expect(postedBy({ user: { login: "bot" } }, "bot")).toBe(true);
    expect(postedBy({ user: { login: "stranger" } }, "bot")).toBe(false);
    expect(postedBy({ user: null }, "bot")).toBe(false);
  });
});

describe("postingLogin", () => {
  it("uses the token owner, or the Actions app for the default token", async () => {
    const pat = {
      rest: {
        users: {
          getAuthenticated: () =>
            Promise.resolve({ data: { login: "someone" } }),
        },
      },
    } as never;
    const app = {
      rest: {
        users: {
          getAuthenticated: async () => Promise.reject(new Error("403")),
        },
      },
    } as never;
    expect(await postingLogin(pat)).toBe("someone");
    expect(await postingLogin(app)).toBe(DEFAULT_TOKEN_LOGIN);
  });
});
