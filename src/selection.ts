/**
 * Turns the agent's proposed findings into the ones a review posts: each
 * demonstration re-run from a clean tree, duplicates and weak claims dropped,
 * and the caps applied. Also the run record's entry for each finding.
 */

import type { BudgetLimits } from "./budget.js";
import type { FindingRecord, RunRecord } from "./record.js";
import { isDuplicate } from "./review.js";
import type { Stage } from "./stage.js";
import type { Finding, Patch, PriorFinding, ProposedFinding } from "./types.js";
import { verifyDemonstration, type ScratchTree } from "./verify.js";

interface Selection {
  kept: Finding[];
  dropped: { finding: Finding; reason: string }[];
}

/**
 * Turns the agent's proposals into postable findings: verify each
 * demonstration from a clean tree, drop duplicates and weak unverified
 * claims, then apply the caps with verified findings first.
 */
export async function verifyAndSelect(
  proposed: ProposedFinding[],
  patches: Patch[],
  open: PriorFinding[],
  tree: ScratchTree,
  stage: Stage,
): Promise<Selection> {
  const verified: Finding[] = [];
  const unverified: Finding[] = [];
  const dropped: Selection["dropped"] = [];

  for (const p of proposed) {
    const finding = await verifyProposal(p, patches, tree, stage.record);
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
  p: ProposedFinding,
  patches: Patch[],
  tree: ScratchTree,
  record: RunRecord,
): Promise<Finding> {
  const testPatch =
    p.testPatch !== undefined
      ? patches.find((x) => x.id === p.testPatch)
      : undefined;
  const fixPatch =
    p.fixPatch !== undefined
      ? patches.find((x) => x.id === p.fixPatch)
      : undefined;
  const finding: Finding = {
    ...p,
    verified: false,
    testPatchVerified: null,
    fixPatchVerified: null,
    placement: "body",
  };

  if (testPatch) {
    const result = await verifyDemonstration(tree, testPatch, fixPatch);
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
  unverified.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  const kept: Finding[] = [];
  for (const f of verified) {
    if (kept.length < limits.findings) kept.push(f);
    else dropped.push({ finding: f, reason: "over the findings cap" });
  }
  let unverifiedKept = 0;
  for (const f of unverified) {
    if (
      kept.length < limits.findings &&
      unverifiedKept < limits.unverifiedFindings
    ) {
      kept.push(f);
      unverifiedKept += 1;
    } else {
      dropped.push({ finding: f, reason: "over the unverified cap" });
    }
  }
  return { kept, dropped };
}

export function findingRecord(f: Finding, n: number): FindingRecord {
  return {
    n,
    category: f.category,
    verified: f.verified,
    confidence: f.confidence,
    file: f.file,
    line: f.line,
    title: f.title,
    testPatchVerified: f.testPatchVerified,
    fixPatchVerified: f.fixPatchVerified,
    placement: f.placement,
  };
}

/** The run record's entries for a selection: the kept findings, then the dropped ones with the reason for each. */
export function findingRecords({ kept, dropped }: Selection): FindingRecord[] {
  return [
    ...kept.map((f, i) => findingRecord(f, i + 1)),
    ...dropped.map((d, i) => ({
      ...findingRecord(d.finding, kept.length + i + 1),
      placement: "dropped" as const,
      dropReason: d.reason,
    })),
  ];
}
