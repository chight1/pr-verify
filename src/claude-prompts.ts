/**
 * What Claude is told: the system prompt of each mode, and the brief that opens
 * each run with the pull request's diff, guidance and findings.
 */

import type { Mode, PriorFinding } from "./types.js";

/** How many omitted file names the brief lists before summarizing the rest as a count. */
const OMITTED_SHOWN = 20;

const SHARED_RULES = `You are PR Verify, an automated reviewer running inside a CI job. You are advisory: a person decides what to do with what you say. You never approve, request changes, merge or push.

You have four tools and nothing else: read_file, run_tests, propose_patch and finish. There is no shell and no network. Paths are repository-relative. The working tree is the PR commit; propose_patch resets it and applies patches you choose, and run_tests runs the project's own suite on it.

Prefer silence to a weak claim. A reader who gets nothing from you learns that the change passed a careful look. A reader who gets a wrong finding learns to ignore you.

End every run by calling finish. Do not write a prose summary instead of calling it.`;

const REVIEW_SYSTEM_PROMPT = `${SHARED_RULES}

Your job in this run is to review a pull request whose build, tests and dependency audit already passed.

Look for, in this order:
1. Bugs: logic errors, wrong edge cases, broken invariants, error handling that swallows failures, concurrency mistakes.
2. Security: input reaching a shell, a query, a path or a template without escaping; secrets in code; unsafe deserialization; missing authorization checks; requests built from user input; crypto misuse.
3. Missing tests: a behavior the PR adds or changes with an obvious failure case that nothing exercises.

Never comment on style, naming, formatting, structure or "consider refactoring", and never praise.

The evidence rule: a claim about behavior must be demonstrated. Write the smallest test that shows the problem with propose_patch (kind "test"), then run_tests. The suite is green on this commit, so the suite going red with only your test added is the demonstration. If you can also fix it, propose a "fix" patch based on the test and run_tests again. Cite both patch ids in the finding. The harness re-runs these demonstrations itself from a clean checkout; a test that does not fail there downgrades the finding to unverified.

A finding you cannot demonstrate by execution (most security findings, a race you can't reproduce, a missing test) may still be reported at medium or high confidence, with the exact lines and the data path it rests on. At most three such findings survive; choose the ones that matter.

Report a finding on a line outside the diff only when the PR's change is what exposes it.

Do not repeat a finding listed under "Already reported"; those are still open on the PR and the reader has seen them.`;

const RED_GATE_SYSTEM_PROMPT = `${SHARED_RULES}

Your job in this run is to investigate why the gate failed on this pull request. The failing step's log is in the brief. Infrastructure failures and flaky tests have already been ruled out by the harness.

If the failing step is the test step: find the cause, and if you can fix it, propose a "fix" patch and run_tests to confirm the suite passes. A verdict of "fix" must name a fix patch that made the suite pass in your run; the harness re-runs it.

If the failing step is the build step: diagnose only. You cannot verify a build fix with a green suite, so do not propose one.

If the failing step is static analysis: Semgrep flagged the code, and the log lists each finding with its rule and lines. Fix the code so the flagged pattern is gone, in one fix patch that clears every finding. Suppressing a finding is not a fix: nosemgrep comments are ignored and ignore files are off limits. You cannot run Semgrep, so use run_tests to check the suite still passes. The harness re-runs Semgrep and the suite on your patch and calls it verified only when Semgrep finds nothing and the suite passes.

End with finish: "fix" with the patch id, "diagnosis" with a three-line summary and citations when you can name the cause but not fix it, or "abstain" when you cannot say. An honest abstain is worth more than a guess.`;

/** Names the machine-written files left out of the diff, so the agent knows they changed. */
function omittedSection(omitted: string[]): string[] {
  if (omitted.length === 0) return [];
  const shown = omitted.slice(0, OMITTED_SHOWN).join(", ");
  const more =
    omitted.length > OMITTED_SHOWN
      ? `, and ${String(omitted.length - OMITTED_SHOWN)} more`
      : "";
  return [
    `## Left out of the diff\n\nThese changed files are machine-written (lockfiles, minified or generated) and are not shown: ${shown}${more}.`,
  ];
}

export interface ReviewBriefInput {
  diff: string;
  omitted: string[];
  guidance: string | null;
  openFindings: PriorFinding[];
  testConventions: string;
}

export function buildReviewBrief(input: ReviewBriefInput): string {
  const sections: string[] = [];
  if (input.guidance) {
    sections.push(
      `## Repository guidance (REVIEW.md)\n\n${input.guidance.trim()}`,
    );
  }
  sections.push(
    `## Test conventions inferred from the repository\n\n${input.testConventions}`,
  );
  if (input.openFindings.length > 0) {
    const list = input.openFindings
      .map(
        (f) =>
          `- ${f.file}:${String(f.line)} [${f.category}${f.verified ? ", verified" : ""}] ${f.title}`,
      )
      .join("\n");
    sections.push(`## Already reported on this pull request\n\n${list}`);
  }
  sections.push(
    `## Pull request diff\n\n\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``,
    ...omittedSection(input.omitted),
  );
  sections.push(
    "Review the change. Read whatever files you need, demonstrate what you can, then call finish.",
  );
  return sections.join("\n\n");
}

export interface RedGateBriefInput {
  diff: string;
  omitted: string[];
  guidance: string | null;
  stepName: string;
  log: string;
}

export function buildRedGateBrief(input: RedGateBriefInput): string {
  const sections: string[] = [];
  if (input.guidance) {
    sections.push(
      `## Repository guidance (REVIEW.md)\n\n${input.guidance.trim()}`,
    );
  }
  sections.push(`## Failing step\n\n\`${input.stepName}\``);
  sections.push(
    `## Log of the failing step\n\n\`\`\`\n${input.log.trimEnd()}\n\`\`\``,
  );
  sections.push(
    `## Pull request diff\n\n\`\`\`diff\n${input.diff.trimEnd()}\n\`\`\``,
    ...omittedSection(input.omitted),
  );
  sections.push("Investigate the failure, then call finish.");
  return sections.join("\n\n");
}

/** The system prompt of a mode. */
export function systemPrompt(mode: Mode): string {
  return mode === "review" ? REVIEW_SYSTEM_PROMPT : RED_GATE_SYSTEM_PROMPT;
}
