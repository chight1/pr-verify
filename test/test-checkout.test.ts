import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoAt } from "./harness-fixtures.js";

describe("TestCheckout.runTests", () => {
  it("builds before the suite runs", async () => {
    const files = {
      "build.js": "require('fs').writeFileSync('built.txt', '');\n",
      "tests/built.test.js": "require('fs').accessSync('built.txt');\n",
    };
    expect(await repoAt(1, files, "node build.js").runTests()).toMatchObject({
      exitCode: 0,
      buildFailed: false,
    });
  });

  it("returns a failed build without running the suite", async () => {
    const checkout = repoAt(
      1,
      {
        "build.js": "process.exit(3);\n",
        "tests/ran.test.js": "require('fs').writeFileSync('ran.txt', '');\n",
      },
      "node build.js",
    );
    const run = await checkout.runTests();
    expect(run.buildFailed).toBe(true);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/The build failed/);
    expect(existsSync(path.join(checkout.root, "ran.txt"))).toBe(false);
  });
});
