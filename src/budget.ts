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

/** Cache reads are billed at a tenth of the input rate. */
const CACHE_READ_WEIGHT = 0.1;

/**
 * The most of the token budget a diff may take on its own. The rest is for
 * reading files and running tests. Above it the run is skipped before any
 * API call, because the budget is only charged after a call returns.
 */
const DIFF_BUDGET_SHARE = 0.25;

const BYTES_PER_TOKEN = 4;

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** A rough count for text before it is sent: about four bytes per token for code and English. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export function diffTokenLimit(limits: BudgetLimits): number {
  return Math.floor(limits.tokens * DIFF_BUDGET_SHARE);
}

export interface BudgetUsage {
  /** Input not read from the cache, including input written to it. */
  inputTokens: number;
  outputTokens: number;
  /** Input read from the cache. */
  cachedInputTokens: number;
  toolCalls: number;
  testRuns: number;
  patchAttempts: number;
  elapsedMs: number;
}

export class BudgetExceeded extends Error {
  constructor(public readonly budget: BudgetName) {
    super(`budget exceeded: ${budget}`);
    this.name = "BudgetExceeded";
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
    if (this.elapsedMs() > this.limits.minutes * MS_PER_MINUTE) {
      throw new BudgetExceeded("minutes");
    }
  }

  /**
   * Records usage from one API response. Input written to the cache counts
   * like any other input. Input read from the cache counts at a tenth, the
   * rate it is billed at: every turn re-reads the whole conversation, and
   * counting those re-reads in full would make the cap grow with the square
   * of the turn count instead of with the work done.
   */
  chargeTokens(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }): void {
    this.inputTokens += usage.input + usage.cacheWrite;
    this.outputTokens += usage.output;
    this.cachedInputTokens += usage.cacheRead;
    if (this.chargedTokens() > this.limits.tokens)
      throw new BudgetExceeded("tokens");
  }

  /** What the token budget measures. */
  chargedTokens(): number {
    return (
      this.inputTokens +
      this.outputTokens +
      Math.ceil(this.cachedInputTokens * CACHE_READ_WEIGHT)
    );
  }

  chargeToolCall(): void {
    this.checkClock();
    if (this.toolCalls >= this.limits.toolCalls)
      throw new BudgetExceeded("toolCalls");
    this.toolCalls += 1;
  }

  chargeTestRun(): void {
    if (this.testRuns >= this.limits.testRuns)
      throw new BudgetExceeded("testRuns");
    this.testRuns += 1;
  }

  chargePatchAttempt(): void {
    if (this.patchAttempts >= this.limits.patchAttempts)
      throw new BudgetExceeded("patchAttempts");
    this.patchAttempts += 1;
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Milliseconds left on the agent clock, never negative. */
  remainingMs(): number {
    return Math.max(0, this.limits.minutes * MS_PER_MINUTE - this.elapsedMs());
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
