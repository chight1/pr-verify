/**
 * The schemas of the agent's four tools, as the Messages API takes them.
 * read_file, run_tests and propose_patch are the same in both modes; finish
 * takes findings in review mode and a verdict in red-gate mode.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Mode } from "./types.js";

export const READ_FILE_LIMIT_LINES = 400;
/** The most Claude's read-file tool returns per call. */
export const READ_FILE_LIMIT_KB = 32;

const READ_FILE: Anthropic.Tool = {
  name: "read_file",
  description: `Read a tracked file from the repository at the PR commit. Returns at most ${String(READ_FILE_LIMIT_LINES)} lines or ${String(READ_FILE_LIMIT_KB)} KB per call; use start_line and end_line to read further.`,
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative path." },
      start_line: {
        type: "integer",
        description: "1-based first line to return.",
      },
      end_line: {
        type: "integer",
        description: "1-based last line to return, inclusive.",
      },
    },
    required: ["path"],
  },
};

const RUN_TESTS: Anthropic.Tool = {
  name: "run_tests",
  description:
    "Run the configured test command on the working tree as it currently stands (the PR commit plus any patches applied by your most recent propose_patch). Returns the exit code and the tail of the output.",
  input_schema: { type: "object", properties: {}, required: [] },
};

const PROPOSE_PATCH: Anthropic.Tool = {
  name: "propose_patch",
  description:
    'Propose a unified diff against the PR commit. The tree is reset, the patches listed in base_on are applied in order, then this one. A "test" patch may only add tests; a "fix" patch may not touch only tests. Returns the patch id to cite in finish.',
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["test", "fix"] },
      description: { type: "string", description: "One line." },
      diff: {
        type: "string",
        description: "Unified diff with a/ and b/ prefixes, as git produces.",
      },
      base_on: {
        type: "array",
        items: { type: "integer" },
        description:
          "Ids of earlier accepted patches to apply before this one (a fix is usually based on its test).",
      },
    },
    required: ["kind", "description", "diff"],
  },
};

const REVIEW_FINISH: Anthropic.Tool = {
  name: "finish",
  description:
    "End the review. Report only findings that meet the bar: bugs, security problems and missing tests, each citing the exact file and line. A behavior claim must reference a test patch that fails on the PR commit. Report an empty list when the change is clean.",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["bug", "security", "missing-test"],
            },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            file: {
              type: "string",
              description: "Repository-relative path.",
            },
            line: {
              type: "integer",
              description: "1-based line in the PR head version of the file.",
            },
            title: { type: "string", description: "One line." },
            explanation: {
              type: "string",
              description: "At most four lines.",
            },
            test_patch: {
              type: "integer",
              description:
                "Id of the accepted test patch that demonstrates this finding.",
            },
            fix_patch: {
              type: "integer",
              description:
                "Id of the accepted fix patch that makes the test pass.",
            },
          },
          required: [
            "category",
            "confidence",
            "file",
            "line",
            "title",
            "explanation",
          ],
        },
      },
    },
    required: ["findings"],
  },
};

const RED_GATE_FINISH: Anthropic.Tool = {
  name: "finish",
  description:
    'End the investigation with a verdict: "fix" when an accepted fix patch makes the suite pass, "diagnosis" when you can name the cause with evidence but not fix it, "abstain" when you cannot say.',
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["fix", "diagnosis", "abstain"],
      },
      summary: { type: "string", description: "At most three lines." },
      citations: {
        type: "array",
        items: { type: "string" },
        description: "File:line references and log lines the verdict rests on.",
      },
      fix_patch: {
        type: "integer",
        description: 'Id of the accepted fix patch, for a "fix" verdict.',
      },
    },
    required: ["verdict", "summary", "citations"],
  },
};

export function toolDefinitions(mode: Mode): Anthropic.Tool[] {
  const finish = mode === "review" ? REVIEW_FINISH : RED_GATE_FINISH;
  return [READ_FILE, RUN_TESTS, PROPOSE_PATCH, finish];
}
