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

const USAGE_EXIT_CODE = 2;

const [, , target, author] = process.argv;
const [owner, repo] = target?.split("/") ?? [];
const token = process.env.GITHUB_TOKEN;
if (!owner || !repo || !token) {
  process.stderr.write(
    "usage: GITHUB_TOKEN=... npm run precision -- owner/repo [author]\n",
  );
  process.exit(USAGE_EXIT_CODE);
}

const comments = await fetchRatedComments(
  github.getOctokit(token),
  owner,
  repo,
  author,
);
process.stdout.write(`${renderPrecision(tallyPrecision(comments))}\n`);
