import { describe, expect, it } from "vitest";
import {
  Budget,
  BudgetExceeded,
  diffTokenLimit,
  estimateTokens,
  type BudgetLimits,
} from "../src/budget.js";

const LIMITS: BudgetLimits = {
  tokens: 1000,
  minutes: 1,
  toolCalls: 3,
  testRuns: 1,
  patchAttempts: 1,
  findings: 8,
  unverifiedFindings: 3,
};

function expectTrip(fn: () => void, budget: keyof BudgetLimits): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetExceeded);
    expect((error as BudgetExceeded).budget).toBe(budget);
    return;
  }
  throw new Error(`expected the ${budget} budget to trip`);
}

describe("Budget", () => {
  it("counts cache writes in full and cache reads at a tenth, and names the budget that tripped", () => {
    const budget = new Budget(LIMITS);
    budget.chargeTokens({
      input: 300,
      output: 100,
      cacheRead: 2000,
      cacheWrite: 100,
    });
    expect(budget.chargedTokens()).toBe(300 + 100 + 100 + 200);
    expect(budget.usage()).toMatchObject({
      inputTokens: 400,
      outputTokens: 100,
      cachedInputTokens: 2000,
    });
    expectTrip(() => {
      budget.chargeTokens({
        input: 300,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }, "tokens");
  });

  it("caps tool calls, test runs and patch attempts separately", () => {
    const budget = new Budget(LIMITS);
    budget.chargeToolCall();
    budget.chargeTestRun();
    expectTrip(() => {
      budget.chargeTestRun();
    }, "testRuns");
    budget.chargePatchAttempt();
    expectTrip(() => {
      budget.chargePatchAttempt();
    }, "patchAttempts");
    budget.chargeToolCall();
    budget.chargeToolCall();
    expectTrip(() => {
      budget.chargeToolCall();
    }, "toolCalls");
  });

  it("trips the clock from an injected time source", () => {
    let now = 0;
    const budget = new Budget(LIMITS, () => now);
    budget.checkClock();
    now = 59_000;
    budget.checkClock();
    expect(budget.remainingMs()).toBe(1000);
    now = 61_000;
    expectTrip(() => {
      budget.checkClock();
    }, "minutes");
    expectTrip(() => {
      budget.chargeToolCall();
    }, "minutes");
    expect(budget.remainingMs()).toBe(0);
  });
});

describe("diff size limit", () => {
  it("is a quarter of the token budget, measured at about four bytes per token", () => {
    expect(diffTokenLimit({ ...LIMITS, tokens: 200_000 })).toBe(50_000);
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("é")).toBe(1);
  });
});
