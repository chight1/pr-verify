/**
 * npm run precision -- owner/repo [author]
 *
 * Reads GITHUB_TOKEN. The author defaults to the account the workflow token
 * posts as; pass another login if the action posts with a different token.
 */

import * as github from "@actions/github";
import {
  fetchRatedComments,
  renderPrecision,
  tallyPrecision,
} from "./precision.js";

const [target, author] = process.argv.slice(2);
const [owner, repo] = target?.split("/") ?? [];
const token = process.env.GITHUB_TOKEN;
if (!owner || !repo || !token) {
  console.error(
    "usage: GITHUB_TOKEN=... npm run precision -- owner/repo [author]",
  );
  process.exit(2);
}

const comments = await fetchRatedComments(
  github.getOctokit(token),
  owner,
  repo,
  author,
);
console.log(renderPrecision(tallyPrecision(comments)));
