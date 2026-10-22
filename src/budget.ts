/**
 * Hard limits for one run. Every stage charges the budget before it acts, so
 * the limits are enforced by the harness rather than requested of the model.
 */

export interface BudgetLimits {
  /** Input plus output tokens as reported by the API. */
  tokens: number;
  /** Wall clock for the agent loop, in minutes. */
  minutes: number;
  toolCalls: number;
  testRuns: number;
  patchAttempts: number;
  findings: number;
  unverifiedFindings: number;
}

export type BudgetName = keyof BudgetLimits;

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCalls: number;
  testRuns: number;
  patchAttempts: number;
  elapsedMs: number;
}

export class BudgetExceeded extends Error {
  constructor(public readonly budget: BudgetName) {
    super(`budget exceeded: ${budget}`);
    this.name = 'BudgetExceeded';
  }
}

export class Budget {
  private readonly startedAt: number;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private toolCalls = 0;
  private testRuns = 0;
  private patchAttempts = 0;

  constructor(
    public readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Throws when the wall clock has run out. Called before every API turn and tool call. */
  checkClock(): void {
    if (this.elapsedMs() > this.limits.minutes * 60_000) {
      throw new BudgetExceeded('minutes');
    }
  }

  /**
   * Records usage from one API response. Cached input tokens are counted
   * toward the total too: the design counts "input plus output as reported".
   */
  chargeTokens(usage: { input: number; output: number; cached: number }): void {
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.cachedInputTokens += usage.cached;
    if (this.inputTokens + this.cachedInputTokens + this.outputTokens > this.limits.tokens) {
      throw new BudgetExceeded('tokens');
    }
  }

  chargeToolCall(): void {
    this.checkClock();
    if (this.toolCalls >= this.limits.toolCalls) throw new BudgetExceeded('toolCalls');
    this.toolCalls += 1;
  }

  chargeTestRun(): void {
    if (this.testRuns >= this.limits.testRuns) throw new BudgetExceeded('testRuns');
    this.testRuns += 1;
  }

  chargePatchAttempt(): void {
    if (this.patchAttempts >= this.limits.patchAttempts) throw new BudgetExceeded('patchAttempts');
    this.patchAttempts += 1;
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Milliseconds left on the agent clock, never negative. */
  remainingMs(): number {
    return Math.max(0, this.limits.minutes * 60_000 - this.elapsedMs());
  }

  usage(): BudgetUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      toolCalls: this.toolCalls,
      testRuns: this.testRuns,
      patchAttempts: this.patchAttempts,
      elapsedMs: this.elapsedMs(),
    };
  }
}
