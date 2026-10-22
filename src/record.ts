/**
 * The run record: one JSON file per run, uploaded as a workflow artifact.
 * It is the evidence behind every comment and the data for tuning budgets.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import type { BudgetName } from './budget.js';
import type { ToolCallRecord } from './tools.js';
import type { FindingCategory, GateResult, Mode, Outcome, PriorFinding } from './types.js';

export const RECORD_ARTIFACT_NAME = 'pr-verify-record';
export const RECORD_RETENTION_DAYS = 30;

export interface FindingRecord {
  n: number;
  category: FindingCategory;
  verified: boolean;
  confidence: string;
  file: string;
  line: number;
  title: string;
  testPatchVerified: boolean | null;
  fixPatchVerified: boolean | null;
  placement: 'inline' | 'body' | 'dropped';
  dropReason?: string;
}

export interface RunRecord {
  identity: {
    runId: number;
    repository: string;
    pullRequest: number;
    headSha: string;
    mode: Mode;
    gateResult: GateResult;
    model: string;
  };
  contextSizes: {
    diffBytes: number;
    repositoryMapBytes: number;
    guidanceBytes: number;
    priorFindingsBytes: number;
    failingLogBytes: number;
  };
  toolCalls: ToolCallRecord[];
  findings: FindingRecord[];
  resolvedPriorFindings: PriorFinding[];
  verification: {
    testRuns: number;
    fixRuns: number;
    durationMs: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  wallMs: number;
  outcome: Outcome;
  postedId: number | null;
  budgetTripped: BudgetName | null;
  preclassification: { label: string; evidence: string } | null;
  error: string | null;
}

/** Starts a record with every field present, so a crash mid-run still writes something readable. */
export function emptyRecord(identity: RunRecord['identity']): RunRecord {
  return {
    identity,
    contextSizes: { diffBytes: 0, repositoryMapBytes: 0, guidanceBytes: 0, priorFindingsBytes: 0, failingLogBytes: 0 },
    toolCalls: [],
    findings: [],
    resolvedPriorFindings: [],
    verification: { testRuns: 0, fixRuns: 0, durationMs: 0 },
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    wallMs: 0,
    outcome: 'error',
    postedId: null,
    budgetTripped: null,
    preclassification: null,
    error: null,
  };
}

export async function writeRecord(record: RunRecord, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `run-${record.identity.runId}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

export async function uploadRecord(file: string): Promise<void> {
  const client = new DefaultArtifactClient();
  await client.uploadArtifact(RECORD_ARTIFACT_NAME, [file], path.dirname(file), {
    retentionDays: RECORD_RETENTION_DAYS,
  });
}
