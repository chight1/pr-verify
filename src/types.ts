/**
 * Shared vocabulary for the action. Everything here is plain data; the
 * modules that produce and consume it live next door.
 */

export type Mode = "review" | "red-gate";

export type GateResult = "success" | "failure" | "cancelled" | "skipped";

export type FindingCategory = "bug" | "security" | "missing-test";

type Confidence = "low" | "medium" | "high";

export type PatchKind = "test" | "fix";

/** A finding as the agent reports it in `finish`, before verification. */
export interface ProposedFinding {
  category: FindingCategory;
  confidence: Confidence;
  file: string;
  /** 1-based line in the PR head version of `file`. */
  line: number;
  title: string;
  /** At most four lines; the harness truncates longer text. */
  explanation: string;
  /** Ids of patches previously accepted by `propose_patch`. */
  testPatch?: number;
  fixPatch?: number;
}

/** A finding after the harness has verified (or failed to verify) it. */
export interface Finding extends ProposedFinding {
  verified: boolean;
  testPatchVerified: boolean | null;
  fixPatchVerified: boolean | null;
  /** Where the finding ended up in the posted review. */
  placement: "inline" | "body";
}

/** A finding PR Verify posted on an earlier push of the same PR. */
export interface PriorFinding {
  category: FindingCategory;
  file: string;
  line: number;
  title: string;
  verified: boolean;
  /** Head commit the finding was posted against. */
  headSha: string;
}

/** A prior finding a later push resolved, and how the harness knows. */
export interface ResolvedFinding extends PriorFinding {
  /** test-passes: the finding's own test passes on the new head. line-changed: the line it pointed at was edited. */
  evidence: "test-passes" | "line-changed";
}

export interface Patch {
  id: number;
  kind: PatchKind;
  description: string;
  diff: string;
}

type RedGateVerdict = "fix" | "diagnosis" | "abstain";

export interface RedGateResult {
  verdict: RedGateVerdict;
  summary: string;
  citations: string[];
  fixPatch?: number;
}

export type Outcome =
  | "clean"
  | "findings"
  | "infra"
  | "flaky"
  | "fix"
  | "diagnosis"
  | "abstain"
  | "budget"
  | "too-large"
  | "baseline"
  | "refused"
  | "scan"
  | "error";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
}
