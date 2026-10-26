# PR Verify

A pull-request pipeline in two stages. The **gate** is plain CI: install, lint, build, test, audit, no model anywhere, and it is the only thing that can block a merge. The **review** runs after a green gate: a Claude agent reads the change and may post findings, but every claim about behavior has to be demonstrated by a test that fails on the PR commit before it is posted. One short workflow file attaches both to a project.

The review is advisory. A person decides what to do with it.

## What it will never do

These are enforced by the harness code in `src/`, not requested of the model.

- Approve, request changes, or merge. Every review is posted with the comment event only.
- Push, commit, or keep a patch anywhere. Patches exist only in the comment and in the runner's scratch tree, which is discarded with the machine.
- Run on a pull request from a fork, or on a draft.
- Edit anything under `.github`, or touch a lockfile or dependency manifest.
- Post a behavior claim it could not demonstrate without labelling it unverified, and never more than three unverified findings per review.
- Run more than one review at a time on a PR. A new push cancels the stale run.
- Say anything when it has nothing to say. A clean PR gets a green check and one line in the job summary, no review.

## How verification works

The agent has four tools: `read_file`, `run_tests`, `propose_patch`, and `finish`. No shell, no network, no search. A test patch may only add tests; a fix patch may not touch only tests; both are capped at 200 changed lines across 6 files.

The agent's own test runs are for investigation and decide nothing. When it calls `finish`, the harness redoes each demonstration from a clean reset of the PR commit:

- A **bug** is verified when the test patch alone makes the suite fail.
- A **fix** is verified when the test patch and fix patch together make the suite pass.

A finding whose test does not fail on the clean commit is downgraded to unverified and competes for the three unverified slots with every other undemonstrated claim. A fix that does not verify is left out of the comment and noted in the run record.

On a later push, the harness re-runs each open verified finding's test against the new commit, up to three per push. If it passes, the finding is reported resolved, wherever the fix landed. If it still fails, the finding stays open, even if its line was edited. A finding without a test, or whose test no longer applies, counts as resolved when the line it pointed at changes. Only comments posted by the action's own account are read back, since a finding's test gets run.

Every run writes a JSON record and uploads it as a workflow artifact (30 days): context sizes, the full tool-call trail, each finding and how it verified, token usage, wall time, and which budget tripped if one did. The record is the evidence behind every comment. Finding accuracy is measured by you: a thumbs-down reaction on an inline comment marks it wrong, and `npm run precision -- owner/repo` (with `GITHUB_TOKEN` set) counts those per category, verified and unverified apart.

## When the gate is red

The same action runs with a different brief. A rules-only pre-classifier labels network, registry, out-of-memory, disk, cancellation and timeout failures as infrastructure, and the agent never runs. A test failure is re-run once unchanged; a pass is labelled flaky, and the agent never runs. Otherwise the agent investigates and ends with a verified fix, a diagnosis, or nothing, posted as one PR comment that later runs update in place. Build and lint failures get a diagnosis only, since no green suite can verify those fixes.

## Budgets

Every one is an action input with a default.

| Budget | Default |
| --- | --- |
| Tokens per run (input plus output; cache reads count at a tenth, the rate they are billed at) | 200,000 |
| Diff size | a quarter of the token budget |
| Agent wall clock | 8 minutes |
| Tool calls | 30 |
| Test runs by the agent | 4 |
| Patch proposals | 4 |
| Per test run | 5 minutes, 64 KB of output |
| Per file read | 400 lines or 32 KB |
| Patch size | 200 lines, 6 files |
| Findings per review | 8, of which at most 3 unverified |

When a budget trips, the run ends and names the budget in the record. Nothing unverified is posted.

If the model refuses, the review job fails with an "API refusal" annotation and nothing is posted. The review is never a required check, so a refusal does not block the merge, but it does not pass for a clean run either.

The conversation is cached turn by turn, so each request pays full price only for what is new since the last one.

## Large pull requests

Lockfiles, minified files, source maps and files `.gitattributes` marks `linguist-generated` are left out of the diff the agent sees; the brief names them so the agent knows they changed. If what is left would take more than a quarter of the token budget, the review is skipped before any API call and one comment says so and asks for smaller pull requests. It declines rather than fails: the gate still decides the merge. The comment is removed once a later push fits.

## Linting

The gate lints with a tool picked from `runtime`, so a project needs no setup: `ruff check` for Python, `go vet` for Go, and for Node the project's own `npm run lint` if it has one, otherwise Biome's recommended rules. `lint-command` replaces the default and `lint: false` turns it off. The default linters are pinned to a version, like the runner image.

## Runner image

The gate and the review run on a pinned image, `ubuntu-24.04`, so the gate goes red only when the code changes. A third job, `pr-verify / canary: ubuntu-latest (non-blocking)`, runs the gate's steps on `ubuntu-latest`. Nothing depends on it and it is not a required check: when it fails, the next image breaks something in the project, and the pin should not move until it passes.

## Attaching it to a project

1. Make sure the build and test commands pass on a clean Ubuntu machine with no local model present. Put model calls behind an interface and swap in a fake for tests.
2. Add the Anthropic key as a repository secret named `ANTHROPIC_API_KEY`.
3. Copy the matching file from `templates/` to `.github/workflows/pr-verify.yml` and fill in the commands.
4. In the branch rules, mark `pr-verify / gate` as a required check. Leave `pr-verify / review` and the canary optional; they never block.
5. Optionally add a `REVIEW.md` at the repository root (8 KB cap) saying what matters in this project: invariants, areas to scrutinize, things to ignore. It is read into the review brief verbatim.

Work on branches with pull requests, even solo. Nothing here triggers on a push to the default branch.

## Repository layout

| File | Concern |
| --- | --- |
| `src/main.ts` | Reads inputs, picks the mode from the gate result, runs the stages, always writes the record. |
| `src/context.ts` | Diff, repository map, guidance file, job-log fetch, secret scrubbing. |
| `src/diff.ts` | Unified-diff parser shared by context, review and verify. |
| `src/preclassify.ts` | Infrastructure patterns for red-gate mode. |
| `src/agent.ts` | The Messages API loop, both briefs, prompt caching. |
| `src/tools.ts` | The four tools and their limits. |
| `src/verify.ts` | Scratch-tree reset, patch policy, apply, harness test runs. |
| `src/review.ts` | Posting policy, line-to-diff mapping, markers, prior-finding resolution. |
| `src/record.ts` | The run record and artifact upload. |
| `src/budget.ts` | Token, time, call and finding counters. |
| `src/precision.ts` | Thumbs-down counts per category, run locally with `npm run precision`. |
| `.github/workflows/pr-verify.yml` | The reusable workflow: the gate, its canary, and the review. |
| `templates/` | The one-file workflow a project copies, per runtime. |

## Developing

```
npm install
npm test          # unit tests (vitest)
npm run lint      # Biome, lint rules only
npm run build     # type-check and bundle to dist/index.js with ncc
```

`dist/index.js` is committed, since that is what a consumer's `uses:` line runs.

## Releases

Each release is a permanent tag, `vMAJOR.MINOR.PATCH`, and a GitHub Release with notes. `v1` is a branch that never gets commits of its own: a release fast-forwards it to the newest 1.x tag, so `@v1` always runs the latest release and never a breaking one. A consumer that wants an exact version pins the tag or its commit SHA.

```
git tag v1.2.0 && git push origin v1.2.0
git push origin v1.2.0^{commit}:refs/heads/v1
```

Breaking changes (a renamed or removed input, a default that turns a passing gate red) go out as a new major with its own branch.

## Non-goals for version 1

No approvals or change requests, no merging, no pushing, no fork PRs, no drafts, no style review, no lockfile or dependency changes, no scheduled runs, no multi-repository configuration beyond the one file per project, no directory or search tool.
