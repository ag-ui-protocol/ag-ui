import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastValueFrom, toArray } from "rxjs";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<object>()),
  ...sdk,
}));
import { ClaudeAgentAdapter } from "./adapter";

// https://github.com/ag-ui-protocol/ag-ui/issues/3324
// A resumed SDK session keeps the system prompt it started with, so RunAgentInput
// context/state must reach the model through hooks that run on every run.

type Hooks = Record<
  string,
  { hooks: ((...args: unknown[]) => Promise<Record<string, any>>)[] }[]
>;

/** Fires every callback registered for `event` and joins the additionalContext they return. */
async function fire(
  hooks: Hooks | undefined,
  event: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const context: string[] = [];
  for (const matcher of hooks?.[event] ?? [])
    for (const hook of matcher.hooks) {
      const output = await hook(
        { hook_event_name: event, session_id: "session", ...input },
        input.tool_use_id,
        { signal: new AbortController().signal },
      );
      const added = output?.hookSpecificOutput?.additionalContext;
      if (added) context.push(added);
    }
  return context.join("\n");
}

const color = (value: string) => [{ description: "Favorite color", value }];

const runInput = (
  runId: string,
  value: string,
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput => ({
  threadId: "thread-1",
  runId,
  messages: [
    { id: runId, role: "user", content: "What is my favorite color?" },
  ],
  tools: [],
  state: {},
  context: color(value),
  forwardedProps: {},
  ...overrides,
});

const collect = (
  adapter: ClaudeAgentAdapter,
  input: RunAgentInput,
): Promise<BaseEvent[]> => lastValueFrom(adapter.run(input).pipe(toArray()));

beforeEach(() => {
  vi.clearAllMocks();
  sdk.getSessionMessages.mockResolvedValue([]);
  sdk.getSessionInfo.mockResolvedValue({ sessionId: "session" });
});

describe("state/context delivery", () => {
  it("delivers each run's context on a resumed session", async () => {
    const seen: { resume?: string; systemPrompt: unknown; context: string }[] =
      [];
    sdk.query.mockImplementation(({ options }) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "session" };
        seen.push({
          resume: options.resume,
          systemPrompt: options.systemPrompt,
          context: await fire(options.hooks, "UserPromptSubmit", {
            prompt: "q",
          }),
        });
        yield {
          type: "result",
          subtype: "success",
          session_id: "session",
          is_error: false,
        };
      })(),
    );
    const adapter = new ClaudeAgentAdapter({ systemPrompt: "BASE" });

    for (const [id, value] of [
      ["m1", "red"],
      ["m2", "green"],
      ["m3", "blue"],
    ]) {
      const events = await collect(adapter, runInput(id, value));
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    }

    expect(seen.map((run) => run.resume)).toEqual([
      undefined,
      "session",
      "session",
    ]);
    expect(seen[0].context).toContain("- Favorite color: red");
    expect(seen[1].context).toContain("- Favorite color: green");
    expect(seen[2].context).toContain("- Favorite color: blue");
    expect(seen[2].context).not.toContain("Favorite color: red");
    // The system prompt no longer changes from run to run (prompt caching).
    expect(seen.map((run) => run.systemPrompt)).toEqual([
      "BASE",
      "BASE",
      "BASE",
    ]);
  });

  // A frontend tool result that is an error comes back from the MCP tool with
  // isError, and the CLI then runs PostToolUseFailure instead of PostToolUse.
  async function frontendToolResultOnlyRun(failed: boolean) {
    const call = { id: "confirm-call", name: "mcp__ag_ui__confirm", input: {} };
    const confirm = {
      name: "confirm",
      description: "",
      parameters: { type: "object" },
    };
    const delivered: string[] = [];
    let runs = 0;
    sdk.query.mockImplementation(({ options, prompt }) =>
      (async function* () {
        const resumed = runs++ > 0;
        yield { type: "system", subtype: "init", session_id: "session" };
        if (!resumed) {
          delivered.push(
            await fire(options.hooks, "UserPromptSubmit", { prompt: "q" }),
          );
          await options.hooks.PreToolUse.at(-1).hooks[0]({
            hook_event_name: "PreToolUse",
            tool_use_id: call.id,
            tool_name: call.name,
            tool_input: call.input,
          });
          yield {
            type: "assistant",
            uuid: "assistant-uuid",
            session_id: "session",
            message: {
              id: "assistant",
              role: "assistant",
              content: [{ type: "tool_use", ...call }],
            },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "session",
            is_error: false,
            stop_reason: "tool_deferred",
            deferred_tool_use: call,
          };
          return;
        }
        // The SDK replays the deferred call; no user prompt is submitted, so
        // UserPromptSubmit never fires on this run.
        await options.hooks.PreToolUse.at(-1).hooks[0]({
          hook_event_name: "PreToolUse",
          tool_use_id: call.id,
          tool_name: call.name,
          tool_input: call.input,
        });
        const client = new Client({ name: "provider-free-sdk", version: "1" });
        const config = options.mcpServers.ag_ui;
        let result: Awaited<ReturnType<Client["callTool"]>>;
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers },
            }),
          );
          result = await client.callTool({ name: "confirm", arguments: {} });
        } finally {
          await client.close();
        }
        expect(!!result.isError).toBe(failed);
        delivered.push(
          result.isError
            ? await fire(options.hooks, "PostToolUseFailure", {
                tool_use_id: call.id,
                tool_name: call.name,
                tool_input: call.input,
                error: "declined",
              })
            : await fire(options.hooks, "PostToolUse", {
                tool_use_id: call.id,
                tool_name: call.name,
                tool_input: call.input,
                tool_response: result.content,
              }),
        );
        yield {
          type: "user",
          session_id: "session",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: result.content,
                is_error: result.isError,
              },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "session",
          is_error: false,
        };
        const extra = [];
        for await (const message of prompt) extra.push(message);
        expect(extra).toEqual([]);
      })(),
    );
    const adapter = new ClaudeAgentAdapter();
    const first = await collect(
      adapter,
      runInput("m1", "red", { tools: [confirm] }),
    );
    expect(first.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "success", pendingToolCallIds: [call.id] },
    });

    const second = await collect(
      adapter,
      runInput("r2", "blue", {
        tools: [confirm],
        messages: [
          { id: "m1", role: "user", content: "What is my favorite color?" },
          {
            id: "assistant",
            role: "assistant",
            toolCalls: [
              {
                id: call.id,
                type: "function",
                function: { name: "confirm", arguments: "{}" },
              },
            ],
          },
          {
            id: "result",
            role: "tool",
            toolCallId: call.id,
            content: "confirmed",
            ...(failed ? { error: "declined" } : {}),
          },
        ],
      }),
    );

    expect(second.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
    expect(second.at(-1)?.type).toBe("RUN_FINISHED");
    expect(runs).toBe(2);
    expect(delivered[0]).toContain("- Favorite color: red");
    expect(delivered[1]).toContain("- Favorite color: blue");
  }

  it("delivers context on a run that only carries a frontend tool result", () =>
    frontendToolResultOnlyRun(false));

  it("delivers context on a run that only carries a failed frontend tool result", () =>
    frontendToolResultOnlyRun(true));
});

describe("ClaudeAgentAdapter.buildOptions state/context hooks", () => {
  const input = runInput("r1", "red", { state: { count: 1 } });

  it("leaves a string systemPrompt as configured", () => {
    const options = new ClaudeAgentAdapter({
      systemPrompt: "BASE",
    }).buildOptions(input);
    expect(options.systemPrompt).toBe("BASE");
  });

  it("leaves the preset systemPrompt object as configured", () => {
    const systemPrompt = {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: "Be brief.",
    };
    const options = new ClaudeAgentAdapter({ systemPrompt }).buildOptions(
      input,
    );
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Be brief.",
    });
  });

  it("delivers context and state through UserPromptSubmit once per run", async () => {
    const options = new ClaudeAgentAdapter().buildOptions(input);
    const hooks = options.hooks as unknown as Hooks;

    const context = await fire(hooks, "UserPromptSubmit", { prompt: "q" });
    expect(context).toContain("## Context from the application");
    expect(context).toContain("- Favorite color: red");
    expect(context).toContain('"count": 1');
    // Already delivered on this run, so a later tool result adds nothing.
    expect(
      await fire(hooks, "PostToolUse", { tool_use_id: "t", tool_name: "Read" }),
    ).toBe("");
    expect(
      await fire(hooks, "PostToolUseFailure", {
        tool_use_id: "t",
        tool_name: "Read",
        error: "e",
      }),
    ).toBe("");
    expect(await fire(hooks, "UserPromptSubmit", { prompt: "again" })).toBe("");
  });

  it("delivers context through a failed tool call's PostToolUseFailure", async () => {
    const options = new ClaudeAgentAdapter().buildOptions(input);
    const hooks = options.hooks as unknown as Hooks;

    expect(
      await fire(hooks, "PostToolUseFailure", {
        tool_use_id: "t",
        tool_name: "Read",
        error: "e",
      }),
    ).toContain("- Favorite color: red");
    expect(
      await fire(hooks, "PostToolUse", { tool_use_id: "t", tool_name: "Read" }),
    ).toBe("");
  });

  it("keeps hooks the caller configured", async () => {
    const own = vi.fn(async () => ({}));
    const options = new ClaudeAgentAdapter({
      hooks: {
        UserPromptSubmit: [{ hooks: [own] }],
        PostToolUse: [{ matcher: "Read", hooks: [own] }],
        PostToolUseFailure: [{ matcher: "Read", hooks: [own] }],
      },
    }).buildOptions(input);

    expect(options.hooks?.UserPromptSubmit?.[0].hooks[0]).toBe(own);
    expect(options.hooks?.PostToolUse?.[0]).toMatchObject({ matcher: "Read" });
    expect(options.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(options.hooks?.PostToolUse).toHaveLength(2);
    expect(options.hooks?.PostToolUseFailure?.[0]).toMatchObject({
      matcher: "Read",
    });
    expect(options.hooks?.PostToolUseFailure).toHaveLength(2);
  });

  it("adds no hooks when the run has no context or state", () => {
    const options = new ClaudeAgentAdapter().buildOptions(
      runInput("r1", "red", { context: [], state: undefined }),
    );
    expect(options.hooks).toBeUndefined();
  });
});
