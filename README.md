# PR Verify

A pull-request pipeline in two stages. The **gate** is plain CI: install, lint, static analysis, build, test, audit, security scan, no model anywhere, and it is the only thing that can block a merge. The **review** runs after a green gate: a Claude agent reads the change and may post findings, but every claim about behavior has to be demonstrated by a test that fails on the PR commit before it is posted. One short workflow file attaches both to a project.

The review is advisory. A person decides what to do with it.

## What it will never do

These are enforced by the harness code in `src/`, not requested of the model.

- Approve, request changes, or merge. Every review is posted with the comment event only.
- Push, commit, or keep a patch anywhere. Patches exist only in the comment and in the runner's scratch tree, which is discarded with the machine.
- Run on a pull request from a fork, or on a draft.
- Let the code under test reach the job's secrets, the network, or anything that runs after it.
- Edit anything under `.github`, or touch a lockfile, a dependency manifest or a scanner's ignore file.
- Post a behavior claim it could not demonstrate without labelling it unverified, and never more than three unverified findings per review.
- Run more than one review at a time on a PR. A new push cancels the stale run.
- Say anything when it has nothing to say. A clean PR gets a green check and one line in the job summary, no review.

## How verification works

The agent has four tools: `read_file`, `run_tests`, `propose_patch`, and `finish`. No shell, no network, no search. A test patch may only add tests; a fix patch may not touch only tests; both are capped at 200 changed lines across 6 files.

Before the agent starts, the harness builds the PR commit and runs its suite in the sandbox. If that fails, nothing can be verified, so the agent does not run and one comment shows the output; a later run whose baseline passes deletes it. Every harness run after that builds first, so a patch to the source is compiled before it is tested, and a test that breaks the build demonstrates nothing.

The agent's own test runs are for investigation and decide nothing. When it calls `finish`, the harness redoes each demonstration from a clean reset of the PR commit:

- A **bug** is verified when the test patch alone makes the suite fail.
- A **fix** is verified when the test patch and fix patch together make the suite pass.

Every test run is sandboxed, since the suite is code from the pull request running in the job that holds the Anthropic key. It gets its own network, process and mount namespaces: loopback only, no view of the action's process or environment, only toolchain variables passed in, and the runner's home, temp directories and `/run` replaced by empty ones. The working tree is mounted back with `.git` read-only, so a test cannot leave a hook or config that runs later outside. The command runs as the runner user with no supplementary groups and `no_new_privs`, which rules out sudo and Docker. Building the sandbox needs passwordless sudo, as on GitHub-hosted Ubuntu runners; where it cannot be built, the review fails instead of running tests without it.

A finding whose test does not fail on the clean commit is downgraded to unverified and competes for the three unverified slots with every other undemonstrated claim. A fix that does not verify is left out of the comment and noted in the run record.

On a later push, the harness re-runs each open verified finding's test against the new commit, up to three per push. If it passes, the finding is reported resolved, wherever the fix landed. If it still fails, the finding stays open, even if its line was edited. A finding without a test, or whose test no longer applies, counts as resolved when the line it pointed at changes. Only comments posted by the action's own account are read back, since a finding's test gets run.

Every run writes a JSON record, which the workflow uploads as an artifact (30 days): context sizes, the full tool-call trail, each finding and how it verified, token usage, wall time, and which budget tripped if one did. The record is the evidence behind every comment. Finding accuracy is measured by you: a thumbs-down reaction on an inline comment marks it wrong, and `npm run precision -- owner/repo` (with `GITHUB_TOKEN` set) counts those per category, verified and unverified apart.

## When the gate is red

The same action runs with a different brief. A rules-only pre-classifier labels network, registry, out-of-memory, disk, cancellation and timeout failures as infrastructure, and the agent never runs. A test failure is re-run once unchanged; a pass is labelled flaky, and the agent never runs. Otherwise the agent investigates and ends with a verified fix, a diagnosis, or nothing, posted as one PR comment that later runs update in place. Once the gate passes, that comment says so. Build, lint and formatting failures get a diagnosis only, since no green suite can verify those fixes.

## Budgets

Every one is an action input with a default.

| Budget                                                                                        | Default                          |
| --------------------------------------------------------------------------------------------- | -------------------------------- |
| Tokens per run (input plus output; cache reads count at a tenth, the rate they are billed at) | 200,000                          |
| Diff size                                                                                     | a quarter of the token budget    |
| Agent wall clock                                                                              | 8 minutes                        |
| Tool calls                                                                                    | 30                               |
| Test runs by the agent                                                                        | 4                                |
| Patch proposals                                                                               | 4                                |
| Per test run                                                                                  | 5 minutes, 64 KB of output       |
| Per file read                                                                                 | 400 lines or 32 KB               |
| Patch size                                                                                    | 200 lines, 6 files               |
| Findings per review                                                                           | 8, of which at most 3 unverified |

When a budget trips, the run ends and names the budget in the record. Nothing unverified is posted.

If the model refuses, the review job fails with an "API refusal" annotation and nothing is posted. The review is never a required check, so a refusal does not block the merge, but it does not pass for a clean run either.

The conversation is cached turn by turn, so each request pays full price only for what is new since the last one.

## Large pull requests

Lockfiles, minified files, source maps and files `.gitattributes` marks `linguist-generated` are left out of the diff the agent sees; the brief names them so the agent knows they changed. If what is left would take more than a quarter of the token budget, the review is skipped before any API call and one comment says so and asks for smaller pull requests. It declines rather than fails: the gate still decides the merge. The comment is removed once a later push fits.

## Formatting

The gate checks formatting with `ruff format` for Python, `gofmt` for Go, djLint for Jinja and Django templates, and Prettier for JavaScript, TypeScript, HTML, CSS, Markdown, YAML and JSON. Tools are picked by the files a project has, not by `runtime`, so a Python project's HTML and JavaScript are checked too. Every tool runs with PR Verify's settings, which are each tool's defaults: a project's own config and ignore files have no effect, so a pull request cannot loosen the check. Lockfiles, minified files, source maps and files marked `linguist-generated` are left out. Each tool runs even when another fails, and the log shows each failure in its own group. The tools are pinned to a version.

## Linting

The gate lints with a tool picked from `runtime`, so a project needs no setup: `ruff check` for Python, `go vet` for Go, and for Node the project's own `npm run lint` if it has one, otherwise Biome's recommended rules. `lint-command` replaces the default and `lint: false` turns it off. The default linters are pinned to a version, like the runner image.

## Static analysis

After lint, the gate runs Semgrep with its maintained rules for the runtime (`p/python`, `p/golang`, or `p/javascript` and `p/typescript`), which follow untrusted input to a dangerous call such as a shell command, a query or a file path. `security-scan` sets its mode as well: strict fails on any finding, loose only on ERROR. The engine runs from an image pinned by digest, and the rules come from Semgrep's registry at run time, so a new rule can fail a gate the code passed before, the way a new advisory can for Trivy. There is no ignore file, and inline `nosemgrep` comments are ignored. A failure is investigated like a failing test: when the agent proposes a fix, the harness re-runs Semgrep on it, outside the sandbox since Semgrep reads the code without running it, and the suite inside the sandbox, and calls the fix verified only when Semgrep finds nothing and the suite passes.

## Security scan

Every gate ends with a Trivy filesystem scan for known vulnerabilities in dependencies, committed secrets and misconfigurations. By default it is strict and fails on any finding at any severity; `security-scan: loose` fails only on HIGH and CRITICAL. Nothing can be ignored: the gate runs Trivy with empty settings of its own, so a project's `.trivyignore`, `trivy.yaml` or `trivy-secret.yaml` has no effect, and an inline Trivy ignore comment fails the step. A finding is fixed, not accepted. Trivy is installed from a pinned release and checked against its SHA-256, not through an action. When the scan fails, the review agent does not run, since it cannot run the scanner to verify a fix; one comment points at the step log.

## Runner image

The gate and the review run on a pinned image, `ubuntu-24.04`. A third job, `pr-verify / canary: ubuntu-latest (non-blocking)`, runs the gate's steps on `ubuntu-latest`. Nothing depends on it and it is not a required check: when it fails, the next image breaks something in the project, and the pin should not move until it passes.

Every action the workflows use is pinned to a commit SHA. Dependabot proposes updates as pull requests once a release is a week old.

## Attaching it to a project

1. Make sure the build and test commands pass on a clean Ubuntu machine with no local model present, and the tests without network access.
2. Add the Anthropic key as a repository secret named `ANTHROPIC_API_KEY`. A run without it, such as on a Dependabot pull request, which gets Dependabot's secrets instead, still runs the gate and skips the review.
3. Copy the matching file from `templates/` to `.github/workflows/pr-verify.yml` and fill in the commands.
4. In the branch rules, mark `pr-verify / gate` as a required check. Leave `pr-verify / review` and the canary optional; they never block.
5. Optionally add a `REVIEW.md` at the repository root (8 KB cap) saying what matters in this project: invariants, areas to scrutinize, things to ignore. It is read into the review brief verbatim.

Nothing here runs on a push to the default branch, only on pull requests.

## Repository layout

| File                              | Concern                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/main.ts`                     | Reads inputs, picks the mode from the gate result, runs the stages, always writes the record. |
| `src/context.ts`                  | Diff, repository map, guidance file, job-log fetch, secret scrubbing.                         |
| `src/diff.ts`                     | Unified-diff parser shared by context, review and verify.                                     |
| `src/preclassify.ts`              | Infrastructure patterns for red-gate mode.                                                    |
| `src/agent.ts`                    | The Messages API loop, both briefs, prompt caching.                                           |
| `src/tools.ts`                    | The four tools and their limits.                                                              |
| `src/verify.ts`                   | Scratch-tree reset, patch policy, apply, harness test runs.                                   |
| `src/sandbox.ts`                  | The namespaces every test run executes in.                                                    |
| `src/review.ts`                   | Posting policy, line-to-diff mapping, markers, prior-finding resolution.                      |
| `src/record.ts`                   | The run record.                                                                               |
| `src/budget.ts`                   | Token, time, call and finding counters.                                                       |
| `src/precision.ts`                | Thumbs-down counts per category, run locally with `npm run precision`.                        |
| `.github/workflows/pr-verify.yml` | The reusable workflow: the gate, its canary, and the review.                                  |
| `templates/`                      | The one-file workflow a project copies, per runtime.                                          |

`dist/index.js` is committed, since that is what a consumer's `uses:` line runs.

## Releases

Releases are tagged `vMAJOR.MINOR.PATCH` with notes, and `@v1` runs the latest 1.x release.

## Non-goals for version 1

No approvals or change requests, no merging, no pushing, no fork PRs, no drafts, no style review, no lockfile or dependency changes, no scheduled runs, no multi-repository configuration beyond the one file per project, no directory or search tool.
