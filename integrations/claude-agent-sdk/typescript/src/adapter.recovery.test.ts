import { A2UIMiddleware } from "../../../../middlewares/a2ui-middleware/src";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, expect, it, vi } from "vitest";
import { lastValueFrom, toArray, Subscriber } from "rxjs";
import { buildAguiToolMessage } from "./utils";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
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
import type { SessionBinding } from "./recovery";
const pending = {
  id: "original-call",
  name: "Bash",
  input: { command: "echo test" },
};
const request = (behavior?: string): RunAgentInput => ({
  threadId: "public",
  runId: "run",
  messages: [],
  tools: [],
  state: {},
  context: [],
  forwardedProps: {},
  ...(behavior
    ? {
        resume: [
          {
            interruptId: pending.id,
            status: "resolved",
            payload: { behavior },
          },
        ],
      }
    : {}),
});
const collect = (
  adapter: ClaudeAgentAdapter,
  input: RunAgentInput,
): Promise<BaseEvent[]> => lastValueFrom(adapter.run(input).pipe(toArray()));
beforeEach(() => {
  vi.clearAllMocks();
  sdk.getSessionMessages.mockResolvedValue([]);
  sdk.getSessionInfo.mockResolvedValue({ sessionId: "original-session" });
});
for (const behavior of ["allow", "deny"])
  it(`restores original session/profile after restart and ${behavior}s original call`, async () => {
    let saved: SessionBinding | undefined;
    const decisions: string[] = [];
    const store = {
      load: async () => structuredClone(saved),
      save: async (_id: string, value: SessionBinding) => {
        saved = structuredClone(value);
      },
    };
    sdk.query.mockImplementation(({ options, prompt }) =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "original-session",
        };
        if (options.resume) {
          expect(options.resume).toBe("original-session");
          expect(options.forkSession).toBe(false);
          expect(options.cwd).toBe("/original");
          expect(typeof prompt[Symbol.asyncIterator]).toBe("function");
          const result = await options.hooks.PreToolUse[
            options.hooks.PreToolUse.length - 1
          ].hooks[0]({
            hook_event_name: "PreToolUse",
            tool_use_id: pending.id,
            tool_name: pending.name,
            tool_input: pending.input,
          });
          decisions.push(result.hookSpecificOutput.permissionDecision);
        }
        yield {
          type: "result",
          subtype: "success",
          session_id: "original-session",
          is_error: false,
          ...(options.resume
            ? {}
            : { stop_reason: "tool_deferred", deferred_tool_use: pending }),
        };
      })(),
    );
    const config = {
      sessionRecovery: {
        store,
        profile: "original-profile",
        resolveProfile: vi.fn(async () => ({ cwd: "/original" })),
      },
    };
    const first = await collect(new ClaudeAgentAdapter(config), request());
    expect(first[first.length - 1]).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt", interrupts: [{ id: pending.id }] },
    });
    const second = await collect(
      new ClaudeAgentAdapter(config),
      request(behavior),
    );
    expect(second[second.length - 1]).toMatchObject({ type: "RUN_FINISHED" });
    expect(decisions).toEqual([behavior]);
    expect(saved).toEqual({
      sessionId: "original-session",
      profile: "original-profile",
    });
    expect(config.sessionRecovery.resolveProfile).toHaveBeenCalledWith(
      "original-profile",
    );
  });
it("does not spawn a replacement for a missing imported session", async () => {
  sdk.getSessionInfo.mockResolvedValue(undefined);
  const events = await collect(new ClaudeAgentAdapter(), {
    ...request(),
    forwardedProps: { resume: "missing-session" },
  });
  expect(sdk.query).not.toHaveBeenCalled();
  expect(events[events.length - 1]).toMatchObject({
    type: "RUN_ERROR",
    message: expect.stringContaining("unavailable"),
  });
});
it("keeps pending recovery actionable without re-running the SDK", async () => {
  const config = {
    sessionRecovery: {
      profile: "profile",
      resolveProfile: async () => ({}),
      store: {
        load: async () => ({
          sessionId: "original-session",
          profile: "profile",
          pending,
        }),
        save: vi.fn(),
      },
    },
  };
  const events = await collect(new ClaudeAgentAdapter(config), request());
  expect(sdk.query).not.toHaveBeenCalled();
  expect(events[events.length - 1]).toMatchObject({
    type: "RUN_FINISHED",
    outcome: { type: "interrupt" },
  });
});
it("keeps frontend deferral pending with a ready HTTP proxy", async () => {
  const deferred = {
    id: "frontend-original",
    name: "mcp__ag_ui__confirm",
    input: {},
  };
  const adapter = new ClaudeAgentAdapter({
    sessionRecovery: {
      profile: "profile",
      resolveProfile: async () => ({}),
      store: {
        load: async () => ({
          sessionId: "original-session",
          profile: "profile",
          pending: deferred,
        }),
        save: vi.fn(),
      },
    },
  });
  const events = await collect(adapter, {
    ...request(),
    tools: [
      { name: "confirm", description: "", parameters: { type: "object" } },
    ],
  });
  expect(sdk.query).not.toHaveBeenCalled();
  expect(events[events.length - 1]).toMatchObject({
    type: "RUN_FINISHED",
    outcome: { type: "success", pendingToolCallIds: [deferred.id] },
  });
});

for (const eviction of ["clear", "ttl", "capacity"] as const)
  it(`drops the in-memory recovery binding on ${eviction}`, async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resumes: (string | undefined)[] = [];
    sdk.query.mockImplementation(({ options }) =>
      (async function* () {
        resumes.push(options.resume);
        yield {
          type: "system",
          subtype: "init",
          session_id: `session-${resumes.length}`,
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: `session-${resumes.length}`,
          is_error: false,
        };
      })(),
    );
    const adapter = new ClaudeAgentAdapter({
      sessionTtlMs: 100,
      maxSessions: 1,
    });
    const initial = { ...request(), state: null };
    try {
      await collect(adapter, initial);
      if (eviction === "clear") adapter.clearSession(initial.threadId);
      if (eviction === "ttl") now += 101;
      if (eviction === "capacity") {
        now += 1;
        await collect(adapter, { ...initial, threadId: "other" });
        expect(Reflect.get(adapter, "bindings").size).toBe(1);
      }
      await collect(adapter, initial);
      expect(resumes.at(-1)).toBeUndefined();
      expect(Reflect.get(adapter, "bindings").size).toBeLessThanOrEqual(1);
    } finally {
      clock.mockRestore();
    }
  });

for (const isError of [false, true])
  for (const fullHistory of [false, true])
    it(`reconciles frontend snapshot echo: error=${isError}, history=${fullHistory}`, async () => {
      const history: RunAgentInput["messages"] = fullHistory
        ? [
            { id: "user", role: "user", content: "Confirm" },
            {
              id: "assistant",
              role: "assistant",
              toolCalls: [
                {
                  id: "original",
                  type: "function",
                  function: { name: "confirm", arguments: "{}" },
                },
              ],
            },
          ]
        : [];
      const input: RunAgentInput = {
        ...request(),
        messages: [
          ...history,
          {
            id: "answer",
            role: "tool",
            toolCallId: "original",
            content: "submitted",
            ...(isError ? { error: "failed" } : {}),
          },
        ],
      };
      const events: BaseEvent[] = [];
      const adapter = new ClaudeAgentAdapter();
      const stream = (async function* () {
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "original",
                content: "native saved result",
                is_error: isError,
              },
            ],
          },
        };
      })();
      await Reflect.get(adapter, "streamMessages").call(
        adapter,
        stream,
        input.threadId,
        input.runId,
        input,
        new Set(),
        new Subscriber<BaseEvent>({
          next: (e: BaseEvent) => {
            events.push(e);
          },
          error: (error: unknown) => {
            throw error;
          },
          complete: () => {},
        }),
        { currentState: null },
      );
      const snapshot = events.find((e) => e.type === "MESSAGES_SNAPSHOT");
      expect(snapshot).toMatchObject({
        messages: [
          ...history,
          {
            ...buildAguiToolMessage("original", "native saved result", isError),
            id: "answer",
          },
        ],
      });
      expect(Reflect.get(snapshot!, "messages")).toHaveLength(
        history.length + 1,
      );
    });

for (const newInput of [false, true])
  it(`retains new user input after durable recovery, newInput=${newInput}`, async () => {
    const received: unknown[] = [];
    sdk.query.mockImplementation(({ options, prompt }) =>
      (async function* () {
        const incoming = (async () => {
          for await (const message of prompt)
            received.push(message.message.content);
        })();
        await options.hooks.PreToolUse.at(-1).hooks[0]({
          hook_event_name: "PreToolUse",
          tool_use_id: pending.id,
          tool_name: pending.name,
          tool_input: pending.input,
        });
        expect(received).toEqual([]);
        yield {
          type: "result",
          subtype: "success",
          session_id: "original-session",
          is_error: false,
        };
        await incoming;
        if (newInput)
          yield {
            type: "result",
            subtype: "success",
            session_id: "original-session",
            is_error: false,
          };
      })(),
    );
    const adapter = new ClaudeAgentAdapter({
      sessionRecovery: {
        profile: "profile",
        resolveProfile: async () => ({}),
        store: {
          load: async () => ({
            sessionId: "original-session",
            profile: "profile",
            pending: structuredClone(pending),
          }),
          save: async () => {},
        },
      },
    });
    const events = await collect(adapter, {
      ...request("allow"),
      messages: [
        { id: "old", role: "user", content: "Old instruction" },
        {
          id: "call",
          role: "assistant",
          toolCalls: [
            {
              id: pending.id,
              type: "function",
              function: {
                name: pending.name,
                arguments: JSON.stringify(pending.input),
              },
            },
          ],
        },
        ...(newInput
          ? [{ id: "new", role: "user" as const, content: "New instruction" }]
          : []),
      ],
    });
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(received).toEqual(newInput ? ["New instruction"] : []);
    expect(sdk.query).toHaveBeenCalledTimes(1);
  });

it("completes an A2UI call through the actual SDK loopback tool with its native ID", async () => {
  const original = {
    id: "native-render",
    name: "mcp__ag_ui__render_a2ui",
    input: {
      surfaceId: "card",
      components: [{ id: "root", component: "Text", text: "Hello" }],
    },
  };
  const delivered: unknown[] = [];
  let runs = 0;
  sdk.query.mockImplementation(({ options, prompt }) =>
    (async function* () {
      const resumed = runs++ > 0;
      yield { type: "system", subtype: "init", session_id: "original-session" };
      const decision = await options.hooks.PreToolUse.at(-1).hooks[0]({
        hook_event_name: "PreToolUse",
        tool_use_id: original.id,
        tool_name: original.name,
        tool_input: original.input,
      });
      expect(decision.hookSpecificOutput.permissionDecision).toBe(
        resumed ? "allow" : "defer",
      );
      if (!resumed) {
        yield {
          type: "assistant",
          uuid: "assistant-uuid",
          session_id: "original-session",
          message: {
            id: "assistant",
            role: "assistant",
            content: [{ type: "tool_use", ...original }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "original-session",
          is_error: false,
          stop_reason: "tool_deferred",
          deferred_tool_use: original,
        };
        return;
      }
      const client = new Client({ name: "provider-free-sdk", version: "1" });
      const config = options.mcpServers.ag_ui;
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers },
          }),
        );
        const result = await client.callTool({
          name: "render_a2ui",
          arguments: original.input,
        });
        delivered.push(result);
        yield {
          type: "user",
          session_id: "original-session",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: original.id,
                content: result.content,
                is_error: result.isError,
              },
            ],
          },
        };
      } finally {
        await client.close();
      }
      yield {
        type: "result",
        subtype: "success",
        session_id: "original-session",
        is_error: false,
        result: "Here is your card",
      };
      const extra = [];
      for await (const message of prompt) extra.push(message);
      expect(extra).toEqual([]);
    })(),
  );
  const adapter = new ClaudeAgentAdapter();
  const input = {
    ...request(),
    messages: [{ id: "user", role: "user" as const, content: "Show a card" }],
  };
  const events = await lastValueFrom(
    new A2UIMiddleware({
      injectA2UITool: true,
      schema: {
        catalogId: "test",
        components: { Text: { type: "object", required: ["text"] } },
      },
    })
      .run(input, adapter)
      .pipe(toArray()),
  );
  expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
  expect(runs).toBe(2);
  expect(delivered).toEqual([
    { content: [{ type: "text", text: '{"status":"rendered"}' }] },
  ]);
  expect(
    new Set(
      events
        .filter((event) => event.type === "TOOL_CALL_RESULT")
        .map((event) => event.messageId),
    ).size,
  ).toBe(1);
  expect(events.filter((event) => event.type === "RUN_STARTED")).toHaveLength(
    1,
  );
  expect(events.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(
    1,
  );
});

it("closes the SDK query when a middleware consumer cancels", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stopped!: () => void;
  const closed = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const close = vi.fn(() => stopped());
  sdk.query.mockImplementation(() =>
    Object.assign(
      (async function* () {
        started();
        await closed;
      })(),
      { close },
    ),
  );
  const adapter = new ClaudeAgentAdapter();
  const subscription = adapter.run({ ...request(), state: null }).subscribe();
  await ready;
  subscription.unsubscribe();
  expect(close).toHaveBeenCalledOnce();
});

for (const native of [false, true])
  it(`rejects legacy ${native ? "native" : "frontend"} batches before consuming the surviving call`, async () => {
    const calls = [0, 1, 2].map((i) => ({
      ...pending,
      id: `batch-${i}`,
      name: native ? "Bash" : "mcp__ag_ui__confirm",
    }));
    let saved: SessionBinding = {
      sessionId: "original-session",
      profile: "original",
      pending: calls[2],
    };
    sdk.getSessionMessages.mockResolvedValue([
      {
        message: {
          content: calls.map((call) => ({ type: "tool_use", ...call })),
        },
      },
    ]);
    const adapter = new ClaudeAgentAdapter({
      sessionRecovery: {
        profile: "original",
        resolveProfile: async () => ({ cwd: "/original" }),
        store: {
          load: async () => structuredClone(saved),
          save: async (_id, value) => {
            saved = structuredClone(value);
          },
        },
      },
    });
    const submitted: RunAgentInput = {
      ...request(),
      messages: [
        ...(native
          ? []
          : [
              {
                id: "answer",
                role: "tool" as const,
                toolCallId: calls[2].id,
                content: "actual result",
              },
            ]),
        { id: "next-user", role: "user", content: "Keep this next message" },
      ],
      ...(native
        ? {
            resume: [
              {
                interruptId: calls[2].id,
                status: "resolved" as const,
                payload: { behavior: "allow" },
              },
            ],
          }
        : {}),
    };
    const before = structuredClone(submitted);
    const events = await collect(adapter, submitted);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: expect.stringContaining("multiple pending tool calls"),
    });
    expect(saved.unsupportedPendingTools).toEqual(calls);
    expect(saved.pending).toEqual(calls[2]);
    expect(saved.sessionId).toBe("original-session");
    expect(submitted).toEqual(before);
    expect(sdk.query).not.toHaveBeenCalled();
  });

for (const cancelled of [false, true])
  it(`retains a batch before a result on ${cancelled ? "cancellation" : "exception"} across fresh adapters`, async () => {
    let saved: SessionBinding | undefined;
    let ready!: () => void, release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = [0, 1].map((n) => ({ ...pending, id: `interrupted-${n}` }));
    sdk.query.mockImplementation(({ options }) =>
      Object.assign(
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "original-session",
          };
          for (const call of calls)
            await options.hooks.PreToolUse.at(-1).hooks[0]({
              hook_event_name: "PreToolUse",
              session_id: "original-session",
              tool_use_id: call.id,
              tool_name: call.name,
              tool_input: call.input,
            });
          ready();
          if (cancelled) await closed;
          else throw new Error("transport disconnected before result");
        })(),
        { close: release },
      ),
    );
    const config = {
      sessionRecovery: {
        profile: "original",
        deferTools: ["Bash"],
        resolveProfile: async () => ({}),
        store: {
          load: async () => saved && JSON.parse(JSON.stringify(saved)),
          save: async (_id: string, value: SessionBinding) => {
            saved = JSON.parse(JSON.stringify(value));
          },
        },
      },
    };
    const initial = {
      ...request(),
      state: null,
      messages: [{ id: "user", role: "user" as const, content: "start" }],
    };
    if (cancelled) {
      const subscription = new ClaudeAgentAdapter(config)
        .run(initial)
        .subscribe();
      await deferred;
      subscription.unsubscribe();
    } else await collect(new ClaudeAgentAdapter(config), initial);
    expect(saved?.unsupportedPendingTools).toEqual(calls);
    const before = structuredClone(saved);
    const events = await collect(new ClaudeAgentAdapter(config), {
      ...initial,
      runId: "fresh",
      messages: [{ id: "next", role: "user", content: "do not consume" }],
    });
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      message: expect.stringContaining("multiple pending tool calls"),
    });
    expect(saved).toEqual(before);
    expect(sdk.query).toHaveBeenCalledOnce();
  });

for (const childOrder of ["none", "first", "last"] as const)
  for (const ending of ["success", "sdk-error", "exception"] as const)
    it(`does not retain completed batch calls after ${ending} (child=${childOrder})`, async () => {
      let saved: string | undefined;
      const calls = [0, 1].map((n) => ({ ...pending, id: `completed-${n}` }));
      const child = {
        id: "completed-child",
        name: "Read",
        input: { file_path: "example.txt" },
      };
      const childResult = {
        type: "user",
        session_id: "original-session",
        parent_tool_use_id: "parent-agent",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: child.id,
              content: "Child completed",
              is_error: false,
            },
          ],
        },
      };
      sdk.query.mockImplementation(({ options }) =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "original-session",
          };
          if (sdk.query.mock.calls.length === 1) {
            for (const call of calls)
              await options.hooks.PreToolUse.at(-1).hooks[0]({
                hook_event_name: "PreToolUse",
                session_id: "original-session",
                tool_use_id: call.id,
                tool_name: call.name,
                tool_input: call.input,
              });
            if (childOrder !== "none")
              yield {
                type: "assistant",
                session_id: "original-session",
                parent_tool_use_id: "parent-agent",
                message: {
                  id: "child-message",
                  content: [{ type: "tool_use", ...child }],
                },
              };
            if (childOrder === "first") yield childResult;
            yield {
              type: "user",
              session_id: "original-session",
              message: {
                role: "user",
                content: calls.map((call) => ({
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: "Actually completed",
                  is_error: false,
                })),
              },
            };
            if (childOrder === "last") yield childResult;
            if (ending === "exception")
              throw new Error("transport disconnected after completion");
          }
          yield {
            type: "result",
            subtype: "success",
            session_id: "original-session",
            is_error:
              sdk.query.mock.calls.length === 1 && ending === "sdk-error",
          };
        })(),
      );
      const config = {
        sessionRecovery: {
          profile: "original",
          deferTools: ["Bash"],
          resolveProfile: async () => ({}),
          store: {
            load: async () =>
              saved ? (JSON.parse(saved) as SessionBinding) : undefined,
            save: async (_id: string, value: SessionBinding) => {
              saved = JSON.stringify(value);
            },
          },
        },
      };
      const input = {
        ...request(),
        state: null,
        messages: [{ id: "start", role: "user" as const, content: "start" }],
      };
      await collect(new ClaudeAgentAdapter(config), input);
      expect(saved).toBeDefined();
      const restored = JSON.parse(saved!) as SessionBinding;
      expect(restored.pending).toBeUndefined();
      const events = await collect(new ClaudeAgentAdapter(config), {
        ...input,
        runId: "fresh",
        messages: [{ id: "next", role: "user", content: "new user turn" }],
      });
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
      expect(sdk.query).toHaveBeenCalledTimes(2);
      expect(restored.unsupportedPendingTools).toBeUndefined();
    });

it.each([false, true])(
  "waits for each queued recovery turn before sending the next (error=%s)",
  async (isError) => {
    const received: unknown[] = [];
    let beforeFirstResult: unknown[] = [];
    let incoming: Promise<void> | undefined;
    let firstReceived!: () => void;
    const first = new Promise<void>((resolve) => {
      firstReceived = resolve;
    });
    sdk.query.mockImplementation(({ options, prompt }) =>
      (async function* () {
        incoming = (async () => {
          for await (const message of prompt) {
            received.push(message.message.content);
            firstReceived();
          }
        })();
        await options.hooks.PreToolUse.at(-1).hooks[0]({
          hook_event_name: "PreToolUse",
          tool_use_id: pending.id,
          tool_name: pending.name,
          tool_input: pending.input,
        });
        const result = {
          type: "result",
          subtype: "success",
          session_id: "original-session",
          is_error: false,
        };
        yield result;
        await first;
        // Let the SDK prompt consumer request its next item before completing turn one.
        await new Promise<void>((resolve) => setImmediate(resolve));
        beforeFirstResult = [...received];
        yield { ...result, is_error: isError };
        if (!isError) {
          await incoming;
          yield result;
        }
      })(),
    );
    const adapter = new ClaudeAgentAdapter({
      sessionRecovery: {
        profile: "profile",
        resolveProfile: async () => ({}),
        store: {
          load: async () => ({
            sessionId: "original-session",
            profile: "profile",
            pending: structuredClone(pending),
          }),
          save: async () => {},
        },
      },
    });
    const events = await collect(adapter, {
      ...request("allow"),
      messages: [
        { id: "first", role: "user", content: "First queued message" },
        { id: "second", role: "user", content: "Second queued message" },
      ],
    });
    await incoming;
    expect(beforeFirstResult).toEqual(["First queued message"]);
    expect(received).toEqual(
      isError
        ? ["First queued message"]
        : ["First queued message", "Second queued message"],
    );
    expect(events.at(-1)?.type).toBe(isError ? "RUN_ERROR" : "RUN_FINISHED");
    expect(sdk.query).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "persists child diagnostics before rejecting parent completion (resolved=%s)",
  async (resolved) => {
    let saved: SessionBinding | undefined;
    const child = {
      id: "child-read",
      name: "Read",
      input: { file_path: "/fixture" },
    };
    sdk.query.mockImplementation(() =>
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "original-session",
        };
        yield {
          type: "assistant",
          uuid: "child-message",
          parent_tool_use_id: "parent-agent",
          message: {
            id: "child-message",
            content: [{ type: "tool_use", ...child }],
          },
        };
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "parent-agent",
                content: "Agent launched",
              },
            ],
          },
        };
        yield {
          type: "system",
          subtype: "task_notification",
          status: "completed",
          tool_use_id: "parent-agent",
        };
        if (resolved)
          yield {
            type: "user",
            parent_tool_use_id: "parent-agent",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: child.id,
                  content: "actual result",
                },
              ],
            },
          };
        yield {
          type: "result",
          session_id: "original-session",
          is_error: false,
        };
      })(),
    );
    const config = {
      sessionRecovery: {
        store: {
          load: async () => structuredClone(saved),
          save: async (_id: string, binding: SessionBinding) => {
            saved = structuredClone(binding);
          },
        },
        profile: "test",
        resolveProfile: async () => ({ cwd: "/original" }),
      },
    };
    const events = await collect(new ClaudeAgentAdapter(config), request());
    expect(events.at(-1)?.type).toBe(resolved ? "RUN_FINISHED" : "RUN_ERROR");
    if (!resolved) {
      expect(saved?.unsupportedPendingTools).toEqual([
        { ...child, parentToolUseId: "parent-agent" },
      ]);
      const restarted = await collect(
        new ClaudeAgentAdapter(config),
        request(),
      );
      expect(restarted.at(-1)?.type).toBe("RUN_ERROR");
      expect(sdk.query).toHaveBeenCalledTimes(1);
    }
  },
);

it.each([[], ["FINAL"], ["OTHER"], ["FINAL", "FINAL"]])(
  "reuses only the latest matching unstreamed assistant for result fallback: %j",
  async (...texts: string[]) => {
    sdk.query.mockImplementation(() =>
      (async function* () {
        for (const [i, text] of texts.entries())
          yield {
            type: "assistant",
            uuid: `row-${i}`,
            message: {
              id: `canonical-${i}`,
              role: "assistant",
              content: [{ type: "text", text }],
            },
          };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "FINAL",
          session_id: "original-session",
        };
      })(),
    );
    const events: any[] = await collect(new ClaudeAgentAdapter(), request());
    const assistants = events
      .find((e) => e.type === "MESSAGES_SNAPSHOT")
      .messages.filter((m: { role: string }) => m.role === "assistant");
    const matches = texts.length && texts.at(-1) === "FINAL";
    expect(assistants).toHaveLength(texts.length + (matches ? 0 : 1));
    const start = events.find((e) => e.type === "TEXT_MESSAGE_START");
    expect(start.messageId).toBe(assistants.at(-1).id);
    if (matches) expect(start.messageId).toBe(`canonical-${texts.length - 1}`);
  },
);
