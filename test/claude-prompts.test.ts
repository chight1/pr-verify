import { describe, expect, it } from "vitest";
import { buildRedGateBrief, buildReviewBrief } from "../src/claude-prompts.js";

describe("briefs", () => {
  it("includes guidance, conventions, open findings and the diff in the review brief", () => {
    const brief = buildReviewBrief({
      diff: "diff --git a/x b/x",
      omitted: ["package-lock.json"],
      guidance: "Never call the model in tests.",
      openFindings: [
        {
          category: "bug",
          file: "src/a.ts",
          line: 4,
          title: "Old one",
          verified: true,
          headSha: "h",
        },
      ],
      testConventions: "Tests live under test/.",
    });
    expect(brief).toContain("## Repository guidance");
    expect(brief).toContain("Never call the model in tests.");
    expect(brief).toContain("- src/a.ts:4 [bug, verified] Old one");
    expect(brief).toContain("```diff\ndiff --git a/x b/x\n```");
    expect(brief).toContain("are not shown: package-lock.json.");
  });

  it("leaves optional sections out of the red-gate brief when absent", () => {
    const brief = buildRedGateBrief({
      diff: "d",
      omitted: [],
      guidance: null,
      stepName: "test",
      log: "FAIL",
    });
    expect(brief).not.toContain("Repository guidance");
    expect(brief).not.toContain("Left out of the diff");
    expect(brief).toContain("## Failing step\n\n`test`");
    expect(brief).toContain("FAIL");
  });
});
