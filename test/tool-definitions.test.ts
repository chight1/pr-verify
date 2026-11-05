import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/tool-definitions.js";

describe("toolDefinitions", () => {
  it("exposes exactly four tools in both modes, with finish shaped per mode", () => {
    const review = toolDefinitions("review");
    const red = toolDefinitions("red-gate");
    expect(review.map((t) => t.name)).toEqual([
      "read_file",
      "run_tests",
      "propose_patch",
      "finish",
    ]);
    expect(red.map((t) => t.name)).toEqual([
      "read_file",
      "run_tests",
      "propose_patch",
      "finish",
    ]);
    expect(review[3]?.input_schema.required).toEqual(["findings"]);
    expect(red[3]?.input_schema.required).toEqual([
      "verdict",
      "summary",
      "citations",
    ]);
  });
});
