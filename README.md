# PR Verify

A pull-request pipeline in two stages. The **gate** is plain CI: install, lint, static analysis, build, test, audit, security scan, no model anywhere, and it is the only thing that can block a merge. The **review** runs after a green gate: a Claude agent reads the change and may post findings, but every claim about behavior has to be demonstrated by a test that fails on the PR commit before it is posted. One short workflow file attaches both to a project.

The review is advisory. A person decides what to do with it.

## What it will never do

These are enforced by the harness code in `src/`, not requested of the model.

- Approve, request changes, or merge. Every review is posted with the comment event only.
- Push, commit, or keep a patch anywhere. Patches exist only in the comment and in the runner's test checkout, which is discarded with the machine.
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

On a later push, the harness re-runs each open verified finding's test against the new commit, up to three per push. If it passes, the finding is reported resolved, wherever the fix landed, and its inline comment's thread is marked resolved. If it still fails, the finding stays open, even if its line was edited. A finding without a test, or whose test no longer applies, counts as resolved when the line it pointed at changes. Only comments posted by the action's own account are read back, since a finding's test gets run.

Every run writes a JSON record, which the workflow uploads as an artifact (30 days): context sizes, the full tool-call trail, each finding and how it verified, token usage, wall time, and which budget tripped if one did. The record is the evidence behind every comment. Finding accuracy is measured by you: a thumbs-down reaction on an inline comment marks it wrong, and `npm run precision -- owner/repo` (with `GITHUB_TOKEN` set) counts those per category, verified and unverified apart.

## When the gate is red

The same action runs with a different brief. A rules-only pre-classifier labels network, registry, out-of-memory, disk, cancellation and timeout failures as infrastructure, and the agent never runs. A test failure is re-run once unchanged; a pass is labelled flaky, and the agent never runs. Otherwise the agent investigates and ends with a verified fix, a diagnosis, or nothing, posted as one PR comment that later runs update in place. Once the gate passes, that comment says so. Build, lint and code-quality failures get a diagnosis only, since no green suite can verify those fixes.

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

## Code quality

The gate's `code quality` step checks formatting, lint and types. Tools are picked by the files a project has, not by `runtime`, so a Python project's HTML and JavaScript are checked too.

| Check  | Python                                                                                             | Go                                                                                                                 | JavaScript and TypeScript                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Format | `ruff format`                                                                                      | `gofmt`                                                                                                            | Prettier, which also formats HTML, CSS, Markdown, YAML and JSON; djLint formats Jinja and Django templates                                   |
| Lint   | `ruff check` with every rule, minus docstring style and the rules that conflict with the formatter | `golangci-lint` with errcheck, errorlint, exhaustive, gocritic, govet, ineffassign, revive, staticcheck and unused | ESLint with typescript-eslint's `strict-type-checked` and `stylistic-type-checked`; JavaScript gets the rules that need no type information  |
| Types  | pyright in strict mode                                                                             | the compiler                                                                                                       | `tsc` with every strict flag on, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch` |

Every tool runs with PR Verify's settings, and a project's own config and ignore files have no effect, so a pull request cannot loosen a check. The one exception is the project's `tsconfig.json`, which the type check extends for module settings and paths, with the strict flags forced on top. Suppression comments do nothing: `# noqa`, `# type: ignore`, ESLint directives, zizmor's ignore comments and hadolint's are ignored, and an `@ts-` comment is a lint error. Comments that a tool cannot be told to ignore, such as `# pyright:`, `# fmt: off`, `prettier-ignore`, `djlint:off`, `//nolint`, `# shellcheck disable` and `jscpd:ignore`, fail the step. Lockfiles, minified files, source maps and files marked `linguist-generated` are left out.

Size and complexity have the same limits in every language:

| Limit                              | Value                                | Python                       | Go                      | JavaScript and TypeScript                                        |
| ---------------------------------- | ------------------------------------ | ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| Cognitive complexity per function  | 15                                   | complexipy                   | gocognit                | SonarJS `cognitive-complexity`                                   |
| Cyclomatic complexity per function | 10                                   | ruff `C901`                  | gocyclo                 | `complexity`                                                     |
| Function length                    | 50 lines, or 30 statements in Python | ruff `PLR0915`               | funlen                  | `max-lines-per-function`; for test files, `max-statements` at 30 |
| Parameters                         | 5                                    | ruff `PLR0913`               | revive `argument-limit` | `max-params`                                                     |
| Nesting                            | depth 3                              | through cognitive complexity | nestif                  | `max-depth`                                                      |
| File length                        | 400 lines                            | the gate's own check         | the gate's own check    | the gate's own check                                             |
| Duplicated code                    | 50 tokens                            | jscpd                        | jscpd                   | jscpd                                                            |

Common mistakes are checked in every language:

| Pattern                                                         | Python                         | Go                                    | JavaScript and TypeScript                      |
| --------------------------------------------------------------- | ------------------------------ | ------------------------------------- | ---------------------------------------------- |
| Debug output                                                    | ruff `T20`                     | forbidigo on `fmt.Print*` and `print` | `no-console`                                   |
| Magic numbers, other than 0, 1 and -1, outside a named constant | ruff `PLR2004`, in comparisons | mnd                                   | typescript-eslint `no-magic-numbers`           |
| Commented-out code                                              | ruff `ERA001`                  | gocritic `commentedOutCode`           | SonarJS `no-commented-code`                    |
| A `TODO` or `FIXME` that names no issue                         | ruff `TD003`                   | the gate's own check                  | SonarJS `comment-regex`                        |
| Swallowed errors                                                | ruff `BLE`, `S110`, `S112`     | errcheck, nilerr                      | `no-empty`, typescript-eslint's promise rules  |
| Vague names (`data`, `info`, `tmp`, `res` and the like)         | a Semgrep rule                 | a Semgrep rule                        | `id-match`                                     |
| A test that is always skipped, or asserts nothing               | Semgrep rules                  | Semgrep rules                         | the Vitest plugin's rules, which also fit Jest |

JavaScript and TypeScript also get SonarJS's recommended rules. The Semgrep rules ship in `checks/semgrep.yml` and run from the image the static analysis step uses.

Dead code and dependencies are checked too:

- **Python:** deptry fails an import no dependency provides, a dependency nothing imports, and an import of a package that only arrives through another dependency.
- **Go:** `go mod tidy -diff` must show no changes, and `deadcode` fails a function that nothing reaches from a main package or a test.
- **JavaScript and TypeScript:** knip fails unused files, exports and types, imports of packages `package.json` does not list, duplicate exports and import cycles. knip cannot find every entry point on its own, so from a project's knip config the gate keeps only each workspace's `entry`, and none of its ignores, rules or `project` files. Each entry point must name a file: a pattern such as `**` could make every file an entry point, so that nothing is ever unused, and fails the check.

Dependencies are checked against their registry (npm, PyPI or the Go module proxy), and the ones a pull request adds are found by comparing with its base commit, which the check fetches with the workflow's token, so it runs in the `online checks` step with zizmor:

- Every package in `package.json`, `pyproject.toml`, `requirements*.txt` or `go.mod` fails when the registry has no such package, the mark of a name a model made up or of one the registry removed as malware. One the pull request adds also fails when the registry has had it for under 30 days, which may mean it was registered to catch a made-up name. The check looks up the package actually installed: an npm alias's target, what npm's `overrides`, Yarn's `resolutions` or pnpm's `overrides` swap in, and a Go `replace`'s module. Poetry's groups and `dev-dependencies` are read along with its main table; `setup.py` is code rather than data, so it is not read.
- Every package fetched from git or a URL fails, since no registry vouches for it. One on a local path, including Poetry and uv path and workspace sources, is skipped, since its code is in the repository.
- A version added to a lockfile fails when the registry has no such version, or published it under 7 days ago, the window in which a hijacked release is usually caught, unless an advisory in [OSV](https://osv.dev) names it as the fix for a vulnerability. That covers transitive dependencies. Read: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `go.sum`, and `==` pins in `requirements*.txt`. Locked packages from git, a path or another registry are skipped.

Every project also gets, whatever its runtime:

- LF line endings, no trailing whitespace and a final newline in every text file, including the ones no formatter reads.
- No committed file over 1 MB outside Git LFS.
- typos on every text file and file name. A project's typos config can teach it a word, such as a name in its license, with the word mapped to itself under `[default.extend-words]`. The rest of that config is ignored.
- actionlint on workflows, with shellcheck on every `run:` block, and zizmor on workflows and actions. zizmor requires every action pinned to a commit, except PR Verify's own, which a project calls at `@v1`. zizmor looks actions up on GitHub with the workflow's token, so it runs in an `online checks` step of its own, before the install step runs any of the project's code.
- shellcheck on shell scripts, and hadolint on Dockerfiles.

Each tool runs even when another fails, and the log shows each one in its own group. The type checks and typed lint rules run after install, against the project's dependencies. The tools are pinned to a version.

`lint-command` adds a linter of the project's own, run in its own step after the gate's checks; `lint: false` skips it. Neither can turn the code-quality checks off.

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
| `src/main.ts`                     | Picks the mode from the gate result, runs it, always writes the record.                       |
| `src/inputs.ts`                   | The action's inputs and the pull request from the event.                                      |
| `src/mode-setup.ts`               | What both modes share: the stage, the comment keys, the test checkout.                        |
| `src/review-mode.ts`              | Review mode, step by step: baseline, prior-finding rechecks, agent run, posting.              |
| `src/claude-finding-filter.ts`    | Verification and caps that turn proposals into posted findings.                               |
| `src/red-gate-mode.ts`            | Red-gate mode, step by step: pre-classification, flaky re-run, agent run, fix verification.   |
| `src/skip-notes.ts`               | Comments posted instead of a review: the diff is too large, or tests fail in the sandbox.     |
| `src/claude-context.ts`           | What Claude may see: diff, repository map, guidance file, job log; secret scrubbing.          |
| `src/diff.ts`                     | Unified-diff parser shared by context, review, prior findings and patch policy.               |
| `src/patch-repair.ts`             | Recounts the hunk headers of a patch Claude writes, and explains why `git apply` rejects one. |
| `src/failure-triage.ts`           | Labels infrastructure, scanner and flaky failures in red-gate mode, without Claude.           |
| `src/claude-harness.ts`           | The Messages API loop and prompt caching.                                                     |
| `src/claude-prompts.ts`           | The system prompts of both modes, and both briefs.                                            |
| `src/tool-definitions.ts`         | The four tools' schemas, finish shaped per mode.                                              |
| `src/tool-input.ts`               | Checks on the model's tool input, and the finish payload.                                     |
| `src/tool-executor.ts`            | Runs each tool call: budget, limits, the call trail.                                          |
| `src/patch-policy.ts`             | What a patch may touch, decided from the diff alone.                                          |
| `src/test-checkout.ts`            | Test checkout reset, apply, harness test runs.                                                |
| `src/proof.ts`                    | Demonstration, recheck, red-gate and static analysis verification.                            |
| `src/sandbox.ts`                  | The namespaces every test run executes in.                                                    |
| `src/post-review.ts`              | Posting policy, line-to-diff mapping, the review itself.                                      |
| `src/comment-markers.ts`          | The hidden markers, and reading findings back from comments.                                  |
| `src/prior-findings.ts`           | Prior findings: which this push resolved, and their review threads.                           |
| `src/pr-comments.ts`              | The one comment per key: red-gate verdict, too-large and baseline notes.                      |
| `src/run-record.ts`               | The run record.                                                                               |
| `src/budget.ts`                   | Token, time, call and finding counters.                                                       |
| `src/precision.ts`                | Thumbs-down counts per category, run locally with `npm run precision`.                        |
| `.github/workflows/pr-verify.yml` | The reusable workflow: the gate, its canary, and the review.                                  |
| `templates/`                      | The one-file workflow a project copies, per runtime.                                          |

`dist/index.js` is committed, since that is what a consumer's `uses:` line runs.

## Releases

Releases are tagged `vMAJOR.MINOR.PATCH` with notes, and `@v1` runs the latest 1.x release.

## Non-goals for version 1

No approvals or change requests, no merging, no pushing, no fork PRs, no drafts, no style review, no lockfile or dependency changes, no scheduled runs, no multi-repository configuration beyond the one file per project, no directory or search tool.
