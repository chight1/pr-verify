/**
 * Entry point. Reads inputs, picks the mode from the gate result, runs it,
 * and always writes the run record, even on an internal error. Nothing here
 * talks to the model directly; that is agent.ts.
 */

import path from "node:path";
import * as core from "@actions/core";
import { pullRequestFromEvent, readInputs } from "./inputs.js";
import { writeRecord } from "./record.js";
import { redGateMode } from "./red-gate-mode.js";
import { reviewMode } from "./review-mode.js";
import { createStage } from "./stage.js";
import type { Mode, Outcome } from "./types.js";

async function run(): Promise<void> {
  const startedAt = Date.now();
  const inputs = readInputs();
  const pr = pullRequestFromEvent();
  const mode: Mode = inputs.gateResult === "failure" ? "red-gate" : "review";
  const stage = createStage(inputs, pr, mode);
  const { record } = stage;

  let outcome: Outcome;
  try {
    if (inputs.gateResult === "cancelled" || inputs.gateResult === "skipped") {
      record.outcome = "abstain";
      core.info(`Gate was ${inputs.gateResult}; nothing to do.`);
    } else if (mode === "review") {
      await reviewMode(stage);
    } else {
      await redGateMode(stage);
    }
    outcome = record.outcome;
  } catch (error) {
    record.outcome = "error";
    record.error = stage.scrubber.scrub(
      (error as Error).stack ?? String(error),
    );
    throw error;
  } finally {
    record.wallMs = Date.now() - startedAt;
    core.setOutput("verdict", record.outcome);
    const file = await writeRecord(
      record,
      path.join(process.env.RUNNER_TEMP ?? stage.repoRoot, "pr-verify"),
    );
    core.setOutput("record-path", file);
  }
  core.info(`PR Verify finished: ${outcome}`);
  if (outcome === "refused") {
    core.setFailed(
      "API refusal: the model declined to work on this pull request. Nothing was posted; the run record has the trail.",
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error : String(error));
});
