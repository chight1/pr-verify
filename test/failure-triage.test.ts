import { describe, expect, it } from "vitest";
import { preclassify, scanFailure } from "../src/failure-triage.js";

describe("preclassify", () => {
  it.each([
    [
      "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/x failed",
      "registry",
    ],
    [
      "ERROR: Could not fetch URL https://pypi.org/simple/requests/: connection error",
      "registry",
    ],
    [
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      "out-of-memory",
    ],
    ["Error: ENOSPC: no space left on device, write", "disk"],
    ["##[error]The operation was canceled.", "cancelled"],
    [
      "##[error]The job running on runner x has exceeded the maximum execution time of 20 minutes.",
      "timeout",
    ],
    ["Error: getaddrinfo EAI_AGAIN github.com", "network"],
    ["curl: (28) Connection timed out after 30001 milliseconds", "network"],
  ])("labels %j as %s", (log, label) => {
    expect(preclassify(log)?.label).toBe(label);
  });

  it("returns the matching line as evidence", () => {
    const result = preclassify(
      "setting up\nError: ENOSPC: no space left on device\nbye",
    );
    expect(result?.evidence).toBe("Error: ENOSPC: no space left on device");
  });

  it("leaves a genuine test failure for the agent", () => {
    const log =
      " FAIL test/order.test.ts > total > applies quantity\nAssertionError: expected 10 to be 20\n##[error]Process completed with exit code 1.";
    expect(preclassify(log)).toBeNull();
  });

  it("leaves a compile error for the agent", () => {
    expect(
      preclassify(
        "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      ),
    ).toBeNull();
  });
});

describe("scanFailure", () => {
  it("recognises the scanner steps and nothing else", () => {
    expect(scanFailure("security scan")).toMatch(/^Trivy found/);
    expect(scanFailure("install security scanner")).toMatch(/checksum/);
    expect(scanFailure("static analysis")).toMatch(/^Semgrep found/);
    expect(scanFailure("test")).toBeNull();
    expect(scanFailure("lint")).toBeNull();
  });
});
