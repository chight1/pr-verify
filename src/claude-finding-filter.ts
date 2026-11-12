/**
 * Turns Claude's proposed findings into the ones a review posts: each
 * demonstration re-run from a clean checkout, duplicates and weak claims dropped,
 * and the caps applied. Also the run record's entry for each finding.
 */

import type { BudgetLimits } from "./budget.js";
import { verifyDemonstration } from "./proof.js";
import type { FindingRecord, RunRecord } from "./run-record.js";
import { isDuplicate } from "./post-review.js";
import type { TestCheckout } from "./test-checkout.js";
import type { Stage } from "./mode-setup.js";
import type { Finding, Patch, PriorFinding, ProposedFinding } from "./types.js";

interface Selection {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

/**
 * Turns the agent's proposals into postable findings: verify each
 * demonstration from a clean checkout, drop duplicates and weak unverified
 * claims, then apply the caps with verified findings first.
 */
export async function verifyAndSelect(
  proposed: ProposedFinding[],
  patches: Patch[],
  open: PriorFinding[],
  checkout: TestCheckout,
  stage: Stage,
): Promise<Selection> {
  const verified: Finding[] = [];
  const unverified: Finding[] = [];
  const dropped: Selection["dropped"] = [];

  for (const proposal of proposed) {
    const finding = await verifyProposal(
      proposal,
      patches,
      checkout,
      stage.record,
    );
    if (isDuplicate(finding, open)) {
      dropped.push({
        finding,
        reason: "already reported on this pull request",
      });
      continue;
    }
    if (finding.verified) {
      verified.push(finding);
    } else if (finding.confidence === "low") {
      dropped.push({ finding, reason: "unverified at low confidence" });
    } else {
      unverified.push(finding);
    }
  }
  return applyCaps(verified, unverified, dropped, stage.inputs.limits);
}

/** One proposal as a finding, its demonstration re-run when it has one; a patch that did not hold up is removed. */
async function verifyProposal(
  proposal: ProposedFinding,
  patches: Patch[],
  checkout: TestCheckout,
  record: RunRecord,
): Promise<Finding> {
  const testPatch =
    proposal.testPatch !== undefined
      ? patches.find((patch) => patch.id === proposal.testPatch)
      : undefined;
  const fixPatch =
    proposal.fixPatch !== undefined
      ? patches.find((patch) => patch.id === proposal.fixPatch)
      : undefined;
  const finding: Finding = {
    ...proposal,
    verified: false,
    testPatchVerified: null,
    fixPatchVerified: null,
    placement: "body",
  };

  if (testPatch) {
    const result = await verifyDemonstration(checkout, testPatch, fixPatch);
    record.verification.testRuns += 1;
    record.verification.fixRuns += result.fixPasses === null ? 0 : 1;
    record.verification.durationMs += result.durationMs;
    finding.testPatchVerified = result.testFails;
    finding.fixPatchVerified = result.fixPasses;
    finding.verified = result.testFails === true;
    if (!finding.verified) delete finding.testPatch;
    if (finding.fixPatchVerified !== true) delete finding.fixPatch;
  }
  return finding;
}

/** Keeps findings up to the caps, verified first and unverified by confidence; the rest join `dropped`. */
function applyCaps(
  verified: Finding[],
  unverified: Finding[],
  dropped: Selection["dropped"],
  limits: BudgetLimits,
): Selection {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  unverified.sort(
    (first, second) => rank[first.confidence] - rank[second.confidence],
  );

  const kept: Finding[] = [];
  for (const finding of verified) {
    if (kept.length < limits.findings) kept.push(finding);
    else dropped.push({ finding, reason: "over the findings cap" });
  }
  let unverifiedKept = 0;
  for (const finding of unverified) {
    if (
      kept.length < limits.findings &&
      unverifiedKept < limits.unverifiedFindings
    ) {
      kept.push(finding);
      unverifiedKept += 1;
    } else {
      dropped.push({ finding, reason: "over the unverified cap" });
    }
  }
  return { kept, dropped };
}

export function findingRecord(
  finding: Finding,
  position: number,
): FindingRecord {
  return {
    n: position,
    category: finding.category,
    verified: finding.verified,
    confidence: finding.confidence,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    testPatchVerified: finding.testPatchVerified,
    fixPatchVerified: finding.fixPatchVerified,
    placement: finding.placement,
  };
}

/** The run record's entries for a selection: the kept findings, then the dropped ones with the reason for each. */
export function findingRecords({ kept, dropped }: Selection): FindingRecord[] {
  return [
    ...kept.map((finding, index) => findingRecord(finding, index + 1)),
    ...dropped.map((drop, index) => ({
      ...findingRecord(drop.finding, kept.length + index + 1),
      placement: "dropped" as const,
      dropReason: drop.reason,
    })),
  ];
}
