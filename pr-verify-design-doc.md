# PR Verify — Design Doc

2026-10-22, fourth revision.

## Goal

PR Verify is the pull-request pipeline a lead actually wants: when a PR comes in it builds the project, runs every test, audits the dependencies, and only then lets a Claude agent review the change for bugs and security problems, with evidence. The gate is plain CI with no model in it and is what a required status check is made of. The review is advisory feedback to the human reviewer, which on your repositories is you. One short workflow file attaches the whole thing to any project.

It has two jobs. The first is to be useful every day on Tip Stream, Life Map and whatever comes next: a PR that doesn't build or doesn't pass never reaches a person, and a PR that does gets a second pair of eyes that has to prove what it says. The second is to show judgment about where an agent belongs in a pipeline: it never approves, never merges, never pushes, never posts a behavior claim it couldn't demonstrate without labelling it as such, and says nothing when it has nothing.

Terms used throughout: CI is continuous integration, the automated build-and-test run on every push. PR is pull request. An API is a web interface that programs call, and an SDK is the official client library for one. JSON is plain structured text. "The gate" is the deterministic job (install, build, test, audit). "The review" is the agent job. "The harness" is the deterministic TypeScript around the agent, as opposed to the agent itself. "The runner" is the virtual machine GitHub starts for a job.

## What you need, and what you don't

No infrastructure. GitHub Actions starts a fresh Ubuntu virtual machine for every workflow run, installs the project, runs the steps, and discards the machine. There is no server to stand up, no self-hosted runner and no deployment target; the deploy half of CI/CD does not exist in this project. A repository with no pipeline at all becomes a CI repository the moment a workflow file is committed under .github/workflows.

Each host repository needs four things.

1. Build and test commands that pass on a clean machine with no local model present. The runner has no graphics card and no model files, so in Tip Stream every model call sits behind one interface and the test suite swaps in a fake that returns canned text. The filters, the breadth-first walk and the stream ordering are tested against that fake; the real model is never loaded in CI.
2. The Anthropic key stored as a repository secret named ANTHROPIC_API_KEY. The workflow hands it to the action as an input; nothing else sees it, and the scrubber keeps it out of prompts and records.
3. Work done on branches with pull requests, even solo. Everything here triggers on a pull request, so commits straight to the default branch never start it.
4. The one workflow file described under Packaging, plus, optionally, a REVIEW.md at the repository root.

Cost: standard GitHub-hosted runners are free on public repositories; a private repository on a free personal account has 2,000 runner minutes a month. The gate costs three to five minutes per push and the review five to fifteen, so even a busy month on a private repo stays well inside that. API spend is bounded by the per-run token budget below.

## Stage one: the gate

The gate is one job with ordered, named steps: install, build, test, audit. Each step's name shows in the PR's checks, so a red gate says at a glance whether the code failed to build, failed its tests, or carries a known-vulnerable dependency. The job has no model in it.

Build means whatever proves the code compiles for that project: for TypeScript the build script or the type check; for Python a compile pass over the package plus the type checker if the project uses one; for Go the build and vet. Test is the full suite. Audit is the ecosystem's dependency vulnerability scan (npm audit, pip-audit, govulncheck) at high severity or above, and is optional per project.

In the repository's branch rules, the gate is the required check. That is the only place merge is blocked. The review never blocks anything.

## Stage two: the review

The review runs when the gate is green, the PR is not a draft, and the PR comes from a branch in this repository. Fork PRs skip the agent entirely, both because they don't receive secrets on the pull-request event and because an agent with an API key should never run code a stranger pushed.

What it reads: the PR diff and the changed files, the repository map, the repository's REVIEW.md if one exists, the findings PR Verify already posted on this PR, and whatever files it chooses to open with its read tool.

What it looks for, in priority order. Bugs: logic errors, wrong edge cases, broken invariants, error handling that swallows failures, concurrency mistakes. Security: input reaching a shell, a query, a path or a template without escaping; secrets in code; unsafe deserialization; missing authorization checks; requests built from user input; crypto misuse. Missing tests: a behavior the PR adds or changes with an obvious failure case that nothing exercises. Never style, naming, formatting, "consider refactoring", or praise.

The evidence rule. A finding about behavior must be demonstrated. The agent writes the smallest test that shows the problem and runs the suite. The gate just proved the suite green on this exact commit, so the suite going red with only that test added is the demonstration. Such a finding is posted as verified, with the test in the comment and, when the agent can also produce it, a patch that makes the new test pass and keeps the rest of the suite green, verified by the harness the same way. A finding it cannot demonstrate by execution (most security findings, a race it can't reproduce, a missing-test gap) goes in the unverified lane: at most three per review, medium confidence or higher, each citing the lines and the data path it rests on. Anything that doesn't clear those bars is not posted.

What it posts: one pull-request review per run, with the comment event only, never approve and never request changes. Findings on lines inside the diff become inline comments on those lines; findings about lines outside the diff go into the review body, since GitHub only accepts inline comments on diff lines. The body lists verified findings first, then unverified ones, then findings from earlier reviews that this push resolved, then a collapsed trail: files read, tests written and their results, tokens and wall time, and a link to the run record. A hidden marker tags everything PR Verify posts. A clean PR gets no review at all, only a one-line note in the job summary and a green check.

On a new push, the concurrency group cancels any review still running on the old commit, and the new run fetches the earlier PR Verify findings on the PR by their marker. Each one is checked against the new diff: a finding whose lines changed is listed as resolved in the new body, and an unchanged one is not repeated. The whole PR diff is reviewed again, not only the delta, but with the prior list in hand, so a new review contains only new findings. If there are none and nothing resolved, no review is posted.

## Stage three: when the gate is red

Kept from the original design and scaled down to the rare branch it is on your repositories. When the gate fails, the same action runs with a different brief: it fetches the failing step's log, runs the rules-only pre-classifier (network, registry, out-of-memory, disk, cancellation and timeout failures are labelled infra and the agent never runs), and for a test failure reruns the suite once unchanged (a pass is labelled flaky and the agent never runs). Otherwise the agent investigates with the same tools and ends with a verified fix, a diagnosis, or nothing, posted as one ordinary PR comment that later runs update in place. Build failures get a diagnosis only; the agent does not patch a build it can't verify with a green suite. This branch is built last.

## The agent and its tools

The agent is a plain tool-use loop over the Claude Messages API using the official TypeScript SDK, not an open-ended coding agent. Owning the loop is what makes the limits real: every tool call passes through harness code that counts it, checks it and records it. The model is an input, defaulting to the current Sonnet model.

The agent has exactly four tools.

- read_file takes a repo-relative path and an optional line range. It serves tracked files only, rejects anything that resolves outside the repository, and returns at most 400 lines or 32 KB per call.
- run_tests takes no arguments and runs the configured test command on the scratch tree as it currently stands. It has its own timeout (5 minutes by default) and returns the exit code with the last 64 KB of output.
- propose_patch takes a unified diff, a kind (test or fix) and a one-line description. The harness resets the scratch tree to the PR commit, applies any patches the agent has marked as kept, checks the new patch against the patch policy, applies it, and reports whether it applied cleanly. A test patch may only add files under the project's test directories or add to existing test files. A fix patch follows the size and path rules below.
- finish ends the run. In review mode it carries the list of findings, each with a category (bug, security, missing-test), a confidence (low, medium, high), a file and line, a title, an explanation of at most four lines, and references to the test patch and fix patch it rests on, if any. In red-gate mode it carries a verdict of fix, diagnosis or abstain with a three-line summary and its citations.

The agent has no shell, no network, no write access except through propose_patch, and cannot see or alter the workflow files. There is deliberately no directory listing or search tool in version 1; the repository map and the diff cover that, and every tool left out is one fewer thing to reason about in the guardrails section of the README.

The system prompt states the role, the rules and the output contract. The review rules: only bugs, security and missing tests; demonstrate behavior claims with a test before posting them; cite the exact lines; prefer silence to a weak finding; never comment on style; a finding outside the diff only when the PR's change exposes it. The user message carries the diff, the repository map, the guidance file, the prior findings and the test-directory conventions inferred from the map. The system prompt and repository map sit in a cached prompt prefix so repeated turns don't pay for them again.

The loop runs until finish is called or a budget trips. When a budget trips, the harness ends the run with whatever findings had already been verified, drops anything unverified, and names the budget in the record.

## Verification, in one place

The agent's own run_tests calls are for its investigation and decide nothing. When finish arrives, the harness redoes the demonstrations itself, from a clean reset each time.

A bug is verified when the test patch alone, applied to the PR commit, makes the suite fail. A fix is verified when the test patch and the fix patch together make the suite pass. Only harness runs count. A finding whose test doesn't fail on the clean commit is downgraded to unverified and competes for the three unverified slots like any other; a fix whose verification fails is dropped from the comment and noted in the record.

The patch policy, checked before any patch is applied: at most 200 changed lines across 6 files; no paths outside the repository, no symlinks, no binary files; nothing under .github; no lockfile or dependency-manifest changes; a test patch touches test locations only; a fix patch that touches only tests is never a fix.

Patches in review mode exist only in the comment. Nothing is pushed, committed or kept anywhere but the scratch tree on the runner, which is discarded with the machine.

## Repository guidance

An optional REVIEW.md at the repository root is read into the review brief verbatim, capped at 8 KB. It says what matters in this project: invariants, areas to scrutinize, things to ignore. For Tip Stream that is the stream-ordering invariant, the rule that the model interface is never called in tests, and the dedupe thresholds. It is the one per-project knob.

## Hard limits

All of these are inputs with defaults, and every one is enforced by the harness, not requested of the model.

- Total tokens per run, input plus output as reported by the API: 200,000.
- Agent wall clock: 8 minutes, inside the job's 25-minute timeout.
- Tool calls: 30, of which at most 4 are test runs and at most 4 are patch proposals.
- Per test run: 5 minutes, output capped at 64 KB.
- Per file read: 400 lines or 32 KB.
- Patch size: 200 changed lines, 6 files.
- Findings per review: 8, of which at most 3 unverified.
- Never: approve, request changes, merge, push a branch, edit workflow files, run on fork PRs, run on drafts, run more than once concurrently per PR.

## Run record

Every run writes one JSON file and uploads it as a workflow artifact, kept for 30 days. It is the evidence for everything the review claims and the source for tuning the budgets and the pre-classifier. It holds, in this order:

- Identity: the workflow run id, the repository, the PR number, the head commit, the mode (review or red-gate), and the gate's result.
- Context sizes: bytes of diff, repository map, guidance file and prior findings that went into the brief.
- The tool-call trail: for each call its number, the tool, what it was asked (path and line range, patch kind and files with added and removed line counts), what came back (bytes, exit code, applied or not), and how long it took.
- Findings: for each its number, category, verified flag, confidence, file and line, title, whether its test patch and fix patch verified, and where it was posted (inline or body).
- Prior findings this push resolved.
- Verification: how many bug and fix runs the harness made and their total time.
- Usage: input, output and cached input tokens.
- Wall time, the outcome (clean, findings, infra, flaky, fix, diagnosis, abstain, budget), the id of the review or comment posted if any, and which budget tripped if one did.

Finding accuracy is measured by you, not by a proxy: a thumbs-down reaction on an inline comment marks it wrong, and a small script over the run records and the reactions gives precision per category. It costs one click per wrong finding and nothing otherwise.

## Packaging

PR Verify is one repository holding three things: the action (TypeScript, compiled and bundled into a single dist/index.js with ncc, Vercel's bundler for Node actions, committed on every release tag), the reusable workflow that runs the gate and then the action, and the README. A project attaches it with one short workflow file. The check names in that project appear as "PR Verify / gate" and "PR Verify / review", and "PR Verify / gate" is the one to mark required in the branch rules.

The source files of the action, one concern each, are listed in the README's file table.

The action declares the node24 runtime (node20 also works on an older runner). Dependencies are the Actions toolkit packages for inputs, GitHub API access, process execution and artifact upload, plus the Anthropic TypeScript SDK. Its inputs:

| Input                   | Default                  | Meaning                                                                         |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| gate-result             | required                 | Result of the gate job: success, failure, cancelled or skipped. Picks the mode. |
| build-command           | required                 | The project's build command.                                                    |
| test-command            | required                 | The project's test command, run from the repository root.                       |
| anthropic-api-key       | required                 | The Anthropic key, from the repository secret.                                  |
| github-token            | the job token            | Token for the GitHub API.                                                       |
| model                   | the current Sonnet model | Claude model id.                                                                |
| guidance-file           | REVIEW.md                | Repository guidance file read into the brief.                                   |
| max-findings            | 8                        | Findings allowed in one review.                                                 |
| max-unverified-findings | 3                        | Findings without an executed demonstration allowed in one review.               |
| max-tokens              | 200000                   | Total input plus output tokens per run.                                         |
| max-minutes             | 8                        | Wall-clock budget for the agent loop.                                           |
| max-tool-calls          | 30                       | Total tool calls per run.                                                       |
| max-test-runs           | 4                        | Test runs the agent may request.                                                |
| max-patch-attempts      | 4                        | Patches the agent may propose.                                                  |
| test-timeout-minutes    | 5                        | Timeout for a single test run.                                                  |
| max-patch-lines         | 200                      | Changed lines allowed in one patch.                                             |
| max-patch-files         | 6                        | Files allowed in one patch.                                                     |
| comment-on-red-gate     | true                     | Post a diagnosis or verified fix when the gate fails.                           |

It has one output, verdict, with the same values as the record's outcome, so a later step can branch on it.

The reusable workflow lives in the PR Verify repository and is what a project calls. Its inputs are the runtime (node, python or go) and its version, the install, build, test and audit commands, a switch for the review (on by default), and the model; the Anthropic key is a required secret. It declares two jobs. The gate job checks out the PR, sets up the chosen runtime with the matching setup action, then runs the four named steps in order, skipping audit when no audit command is given, under a 20-minute timeout. The review job needs the gate, repeats the checkout, runtime setup and install because it reruns the tests on its own machine, and calls the action with the gate's result, the build and test commands, the model and the key, under a 25-minute timeout and with the minimum permissions: contents read, pull-requests write for the review, actions read for the job log. Its run condition requires that the run was not cancelled, that the review switch is on, that the PR is not a draft, and that the PR's head repository is this repository. The condition starts with a status-check function on purpose: GitHub silently prepends a success check to any job condition that lacks one, and that check is false once the gate has failed, so without it the red-gate branch would never run.

The file a project commits is short. It triggers on pull requests, declares a concurrency group keyed on the PR number with cancel-in-progress so a new push cancels work on the stale commit, grants the three permissions above, and has one job that uses the reusable workflow at a version tag with the project's runtime, version and four commands, inheriting the repository's secrets. For a Node project the commands are the clean install, the build script, the test script and the npm audit at high severity; for a Python project an editable install plus the test and audit tools, a compile pass over the package, the test runner and pip-audit; for Go the module download, the build with vet, the test run and govulncheck.

## Testing PR Verify itself

Unit tests cover the parts that don't need a model: diff parsing and the mapping of a file and line onto a diff position, the review marker and upsert against a mocked API, prior-finding resolution against a changed diff, the patch policy (size, paths, .github, test-location rule, test-only detection), the guidance file cap, the secret scrubber, and for red-gate mode the log step extraction against saved real logs and the pre-classifier patterns.

The end-to-end path is exercised on fixture branches in the Tip Stream repository, each a PR against the default branch: a seeded logic bug with no covering test (expected: one verified finding with its test and fix, inline on the right line); a seeded shell injection from a request parameter (expected: one unverified security finding on the right line); a pure refactor with full tests (expected: no review posted, green check); a syntax error (expected: red gate at the build step, a diagnosis comment, no review); a deliberately failing test (expected: red gate at the test step, a verified fix comment).

## Build order

One stage at a time, each finished and running on Tip Stream before the next starts.

0. Prepare Tip Stream and the gate alone: the model calls behind one interface with a fake for tests, build and test commands that pass on a clean machine, the key added as a repository secret, the PR Verify repository created with the reusable workflow and review turned off, the one-file workflow committed to Tip Stream. Done when a PR shows the gate green with its four named steps and a broken branch shows it red at the right step.
1. Review skeleton: the action's metadata, the build, the record file, the review upsert with a hard-coded body, review turned on. Done when a green PR gets exactly one review from the action, a second push updates rather than stacks, and a draft PR gets nothing.
2. Context: diff and changed files, repository map, guidance file, prior findings, scrubber, line-to-diff mapping. Done when the record artifact shows the right files and a guidance file's contents for a test PR.
3. Review agent, unverified lane only: the loop with read_file and finish, budgets, the finding caps, inline comments. Done when the seeded-injection branch gets an inline comment on the right line and the clean-refactor branch gets silence.
4. Verification: propose_patch, the patch policy, the harness test runs, the verified lane with test and fix in the comment. Done when the seeded-bug branch gets a verified finding with its test and fix, and a finding whose test doesn't fail on the clean commit is downgraded.
5. Red-gate mode: log fetch and step extraction, pre-classifier, flaky rerun, diagnosis and verified fix as one updating comment. Done when the syntax-error and failing-test fixtures each get the right comment.
6. README written guardrails-first (what it will never do, how verification works, where a person is required), tag v1, attach to Life Map with its own REVIEW.md.

## Non-goals for version 1

No approvals or change requests, no merging, no pushing, no fork PRs, no drafts, no style review, no lockfile or dependency changes, no scheduled runs, no multi-repository configuration beyond the one file per project, no directory or search tool.

Version 2 candidates, in one line each: deterministic code-quality checks (function and file size, dependency cycles) fed to the reviewer as facts and posted on thresholds the project sets; push a verified fix to a branch for a one-click PR; a scheduled mode that runs the suite nightly against the default branch and opens an issue; a search tool once the run records show the agent reading files blind.
