import { describe, expect, it } from 'vitest';
import { Budget, BudgetExceeded, type BudgetLimits } from '../src/budget.js';

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

describe('Budget', () => {
  it('counts cached input toward the token total and names the budget that tripped', () => {
    const budget = new Budget(LIMITS);
    budget.chargeTokens({ input: 400, output: 100, cached: 400 });
    expectTrip(() => budget.chargeTokens({ input: 100, output: 1, cached: 0 }), 'tokens');
    expect(budget.usage()).toMatchObject({ inputTokens: 500, outputTokens: 101, cachedInputTokens: 400 });
  });

  it('caps tool calls, test runs and patch attempts separately', () => {
    const budget = new Budget(LIMITS);
    budget.chargeToolCall();
    budget.chargeTestRun();
    expectTrip(() => budget.chargeTestRun(), 'testRuns');
    budget.chargePatchAttempt();
    expectTrip(() => budget.chargePatchAttempt(), 'patchAttempts');
    budget.chargeToolCall();
    budget.chargeToolCall();
    expectTrip(() => budget.chargeToolCall(), 'toolCalls');
  });

  it('trips the clock from an injected time source', () => {
    let now = 0;
    const budget = new Budget(LIMITS, () => now);
    budget.checkClock();
    now = 59_000;
    budget.checkClock();
    expect(budget.remainingMs()).toBe(1000);
    now = 61_000;
    expectTrip(() => budget.checkClock(), 'minutes');
    expectTrip(() => budget.chargeToolCall(), 'minutes');
    expect(budget.remainingMs()).toBe(0);
  });
});
