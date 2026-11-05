import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildRedGateBrief,
  buildReviewBrief,
  runAgent,
  stoppedOutcome,
} from "../src/agent.js";
import { Budget } from "../src/budget.js";
import type { ToolExecutor } from "../src/tools.js";

type Response = Pick<Anthropic.Message, "content" | "stop_reason"> & {
  usage?: Partial<Anthropic.Usage>;
};

function response(
  stopReason: Anthropic.StopReason,
  content: Anthropic.ContentBlock[],
  usage: Partial<Anthropic.Usage> = {},
): Response {
  return { stop_reason: stopReason, content, usage };
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

const text = (t: string): Anthropic.TextBlock => ({
  type: "text",
  text: t,
  citations: null,
});

/**
 * Scripted Messages API. The loop mutates its `messages` array between calls,
 * so each request is snapshotted at call time to assert on what was sent.
 */
function fakeClient(responses: Response[]) {
  const requests: Anthropic.MessageCreateParams[] = [];
  const create = vi.fn(async (params: Anthropic.MessageCreateParams) => {
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return {
      ...next,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0,
        ...next.usage,
      },
    };
  });
  return {
    client: { messages: { create } } as unknown as Anthropic,
    create,
    requests,
  };
}

function fakeExecutor(finishOn: string) {
  const execute = vi.fn(async (block: Anthropic.ToolUseBlock) => ({
    block: {
      type: "tool_result" as const,
      tool_use_id: block.id,
      content: "ok",
    },
    finished:
      block.name === finishOn
        ? { mode: "review" as const, findings: [] }
        : null,
  }));
  return { executor: { execute } as unknown as ToolExecutor, execute };
}

const budget = () =>
  new Budget({
    tokens: 10_000,
    minutes: 5,
    toolCalls: 30,
    testRuns: 4,
    patchAttempts: 4,
    findings: 8,
    unverifiedFindings: 3,
  });

describe("runAgent", () => {
  it("runs tool calls in order, feeds results back, and stops at finish", async () => {
    const { client, requests } = fakeClient([
      response("tool_use", [
        toolUse("a", "read_file", { path: "x" }),
        toolUse("b", "read_file", { path: "y" }),
      ]),
      response("tool_use", [toolUse("c", "finish", { findings: [] })]),
    ]);
    const { executor, execute } = fakeExecutor("finish");
    const b = budget();

    const outcome = await runAgent({
      client,
      model: "m",
      mode: "review",
      repositoryMap: "map",
      brief: "brief",
      executor,
      budget: b,
    });

    expect(outcome).toEqual({
      finished: { mode: "review", findings: [] },
      budgetTripped: null,
      stopReason: null,
      turns: 2,
    });
    expect(
      execute.mock.calls.map((c) => (c[0] as Anthropic.ToolUseBlock).id),
    ).toEqual(["a", "b", "c"]);

    const second = requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "ok" },
        {
          type: "tool_result",
          tool_use_id: "b",
          content: "ok",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(b.usage()).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
      cachedInputTokens: 100,
    });
  });

  it("keeps one cache breakpoint in the conversation, on the newest message", async () => {
    const { client, requests } = fakeClient([
      response("tool_use", [toolUse("a", "read_file", { path: "x" })]),
      response("tool_use", [toolUse("b", "read_file", { path: "y" })]),
      response("tool_use", [toolUse("c", "finish", { findings: [] })]),
    ]);
    const { executor } = fakeExecutor("finish");
    await runAgent({
      client,
      model: "m",
      mode: "review",
      repositoryMap: "map",
      brief: "brief",
      executor,
      budget: budget(),
    });

    const marked = (params: Anthropic.MessageCreateParams) =>
      params.messages.flatMap((m, i) =>
        typeof m.content === "string"
          ? []
          : m.content
              .filter((b) => "cache_control" in b && b.cache_control)
              .map(() => i),
      );
    expect(requests[0]!.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "brief", cache_control: { type: "ephemeral" } },
      ],
    });
    expect(requests.map(marked)).toEqual([[0], [2], [4]]);
  });

  it("caches the system prompt and repository map as separate prefix blocks", async () => {
    const { client, requests } = fakeClient([
      response("tool_use", [toolUse("c", "finish", { findings: [] })]),
    ]);
    const { executor } = fakeExecutor("finish");
    await runAgent({
      client,
      model: "m",
      mode: "red-gate",
      repositoryMap: "README.md",
      brief: "b",
      executor,
      budget: budget(),
    });
    const params = requests[0]!;
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).toContain("investigate why the gate failed");
    expect(system[1]!.text).toContain("README.md");
    expect(params.tools?.map((t) => ("name" in t ? t.name : t.type))).toEqual([
      "read_file",
      "run_tests",
      "propose_patch",
      "finish",
    ]);
  });

  it("nudges a model that stops talking without finish, then gives up", async () => {
    const { client, create, requests } = fakeClient([
      response("end_turn", [text("Looks fine.")]),
      response("end_turn", [text("Really, fine.")]),
      response("end_turn", [text("Done.")]),
    ]);
    const { executor } = fakeExecutor("finish");
    const outcome = await runAgent({
      client,
      model: "m",
      mode: "review",
      repositoryMap: "",
      brief: "b",
      executor,
      budget: budget(),
    });
    expect(outcome).toMatchObject({
      finished: null,
      stopReason: "no_finish",
      turns: 3,
    });
    expect(create).toHaveBeenCalledTimes(3);
    const last = requests[2]!;
    expect(last.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("Call finish") }],
    });
  });

  it("ends on a refusal without running any tool", async () => {
    const { client } = fakeClient([
      response("refusal", [toolUse("z", "run_tests", {})]),
    ]);
    const { executor, execute } = fakeExecutor("finish");
    const outcome = await runAgent({
      client,
      model: "m",
      mode: "review",
      repositoryMap: "",
      brief: "b",
      executor,
      budget: budget(),
    });
    expect(outcome.stopReason).toBe("refusal");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports the budget that tripped instead of throwing", async () => {
    const { client } = fakeClient([
      response("tool_use", [toolUse("a", "read_file", {})], {
        input_tokens: 20_000,
      }),
    ]);
    const { executor } = fakeExecutor("finish");
    const outcome = await runAgent({
      client,
      model: "m",
      mode: "review",
      repositoryMap: "",
      brief: "b",
      executor,
      budget: budget(),
    });
    expect(outcome).toMatchObject({ finished: null, budgetTripped: "tokens" });
  });

  it("propagates API errors", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("401");
        }),
      },
    } as unknown as Anthropic;
    const { executor } = fakeExecutor("finish");
    await expect(
      runAgent({
        client,
        model: "m",
        mode: "review",
        repositoryMap: "",
        brief: "b",
        executor,
        budget: budget(),
      }),
    ).rejects.toThrow("401");
  });
});

describe("stoppedOutcome", () => {
  const stopped = { finished: null, turns: 1 };

  it("names a refusal, which fails the job, apart from a plain abstain", () => {
    expect(
      stoppedOutcome({
        ...stopped,
        budgetTripped: null,
        stopReason: "refusal",
      }),
    ).toBe("refused");
    expect(
      stoppedOutcome({
        ...stopped,
        budgetTripped: null,
        stopReason: "no_finish",
      }),
    ).toBe("abstain");
    expect(
      stoppedOutcome({ ...stopped, budgetTripped: "tokens", stopReason: null }),
    ).toBe("budget");
  });
});

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
