import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { EventType, type BaseEvent, type MessagesSnapshotEvent, type RunAgentInput, type RunFinishedEvent } from "@ag-ui/core";

import { OpenAIAgentsAdapter } from "./adapter";

/**
 * Collect all events emitted by `adapter.run(input)` into an array, resolving
 * on stream completion (RUN_FINISHED/RUN_ERROR or subscriber terminal).
 */
async function collectEvents(adapter: OpenAIAgentsAdapter, input: RunAgentInput): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error("Timed out collecting adapter events"));
    }, 500);
    const sub = adapter.run(input).subscribe({
      next: (e) => events.push(e as BaseEvent),
      error: (error) => { clearTimeout(timer); reject(error); },
      complete: () => { clearTimeout(timer); resolve(); },
    });
  });
  return events;
}

/**
 * Mock the @openai/agents module at the import boundary so tests never need a
 * real OPENAI_API_KEY or network. The mock records how it was configured and
 * yields a configurable sequence of stream events.
 */

type StreamEvent =
  | { type: "raw_model_stream_event"; data: any }
  | { type: "run_item_stream_event"; name: string; item: any }
  | { type: "agent_updated_stream_event"; agent: any };

let lastRun: {
  agentConfig: Record<string, unknown>;
  input: unknown;
  providerCalls: Record<string, number>;
  setClientCalledWith?: unknown;
  setKeyCalledWith?: string;
  apiMode?: string;
  tracingDisabled?: boolean;
  signal?: AbortSignal;
};

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...overrides,
  } as unknown as RunAgentInput;
}

// We install the mock per-test by overriding the dynamic import. Because the
// adapter imports `@openai/agents` dynamically inside runAsync, we use
// vi.mock with a factory that reads a mutable events ref.
const eventsRef: { events: StreamEvent[]; throwErr?: Error; hold?: Promise<void> } = {
  events: [],
};
vi.mock("@openai/agents", () => {
  return {
    Agent: class {
      constructor(cfg: Record<string, unknown>) {
        lastRun.agentConfig = cfg;
      }
    },
    tool: (options: Record<string, unknown>) => ({
      // Return a plain object echoing the conversion options so tests can
      // assert what the adapter passed to the SDK `tool()` factory.
      name: options.name,
      description: options.description,
      parameters: options.parameters,
      strict: options.strict,
      execute: options.execute,
      __mockTool: true,
    }),
    run: async (_agent: unknown, input: unknown, opts: { stream: true; signal: AbortSignal }) => {
      lastRun.input = input;
      lastRun.signal = opts.signal;
      if (eventsRef.throwErr) throw eventsRef.throwErr;
      return {
        async *[Symbol.asyncIterator]() {
          if (eventsRef.hold) await eventsRef.hold;
          for (const ev of eventsRef.events) yield ev;
        },
      };
    },
    setDefaultOpenAIClient: (c: unknown) => {
      lastRun.setClientCalledWith = c;
    },
    setDefaultOpenAIKey: (k: string) => {
      lastRun.setKeyCalledWith = k;
    },
    setOpenAIAPI: (v: string) => {
      lastRun.apiMode = v;
    },
    setTracingDisabled: (d: boolean) => {
      lastRun.tracingDisabled = d;
    },
  };
});

// openai is imported dynamically by configureProvider for the LiteLLM path.
vi.mock("openai", () => {
  return {
    default: class {
      opts: unknown;
      constructor(opts: unknown) {
        this.opts = opts;
      }
    },
  };
});

beforeAll(() => {
  // initialize lastRun so the mock's closure has something to write to
  lastRun = {
    agentConfig: {},
    input: undefined,
    providerCalls: {},
  } as any;
});

describe("OpenAIAgentsAdapter — run lifecycle", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    eventsRef.events = [];
    eventsRef.throwErr = undefined;
    eventsRef.hold = undefined;
    lastRun = { agentConfig: {}, input: undefined, providerCalls: {} } as any;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("emits RUN_STARTED → message events → MESSAGES_SNAPSHOT → RUN_FINISHED", async () => {
    eventsRef.events = [
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "Hello" } },
      { type: "run_item_stream_event", name: "message_output_created", item: { rawItem: {} } },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(adapter, baseInput());

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);

    const runFinished = events.find((e) => e.type === EventType.RUN_FINISHED) as any;
    expect(runFinished.outcome).toEqual({ type: "success" });
  });

  it("emits a full tool-call lifecycle", async () => {
    eventsRef.events = [
      { type: "run_item_stream_event", name: "tool_called", item: { rawItem: { callId: "c1", name: "get_weather", arguments: '{"city":"SF"}' } } },
      { type: "run_item_stream_event", name: "tool_output", item: { rawItem: { callId: "c1", name: "get_weather" }, output: "sunny" } },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(adapter, baseInput());

    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
      ]),
    );
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as any;
    expect(result.content).toBe("sunny");
    expect(result.toolCallId).toBe("c1");
  });

  it("emits an initial STATE_SNAPSHOT with input.state when state is present", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(
      adapter,
      baseInput({ state: { theme: "dark" } }),
    );

    const snapshot = events.find((e) => e.type === EventType.STATE_SNAPSHOT) as any;
    expect(snapshot).toBeDefined();
    expect(snapshot.snapshot).toEqual({ theme: "dark" });
    // Initial snapshot comes right after RUN_STARTED.
    const types = events.map((e) => e.type);
    expect(types.indexOf(EventType.STATE_SNAPSHOT)).toBeGreaterThan(
      types.indexOf(EventType.RUN_STARTED),
    );
  });

  it("does not emit an initial STATE_SNAPSHOT when state is null", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(adapter, baseInput({ state: null }));

    expect(events.some((e) => e.type === EventType.STATE_SNAPSHOT)).toBe(false);
  });

  it("intercepts ag_ui_update_state and emits an updated STATE_SNAPSHOT (replace)", async () => {
    eventsRef.events = [
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            callId: "call_s",
            name: "ag_ui_update_state",
            arguments: JSON.stringify({ state: { count: 7 } }),
          },
        },
      },
      {
        type: "run_item_stream_event",
        name: "tool_output",
        item: { rawItem: { callId: "call_s" }, output: "ok" },
      },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(
      adapter,
      baseInput({ state: { count: 0 } }),
    );

    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT) as any[];
    // Initial snapshot ({count:0}) + updated snapshot ({count:7}).
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].snapshot).toEqual({ count: 0 });
    expect(snapshots[1].snapshot).toEqual({ count: 7 });

    // The state tool is never surfaced as a frontend tool call.
    expect(events.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(false);
  });

  it("merges generated assistant + tool messages into MESSAGES_SNAPSHOT", async () => {
    eventsRef.events = [
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "Sure" } },
      { type: "run_item_stream_event", name: "message_output_created", item: { rawItem: {} } },
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: { rawItem: { callId: "c9", name: "lookup", arguments: '{"q":"x"}' } },
      },
      {
        type: "run_item_stream_event",
        name: "tool_output",
        item: { rawItem: { callId: "c9", name: "lookup" }, output: "found" },
      },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(
      adapter,
      baseInput({
        messages: [{ id: "u1", role: "user", content: "hi" } as any],
        state: null,
      }),
    );

    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    expect(snap).toBeDefined();
    const ids = snap.messages.map((m: any) => m.id);
    expect(ids).toContain("u1"); // input message preserved
    expect(ids).toContain("c9"); // tool result message
    const assistant = snap.messages.find((m: any) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant.content).toBe("Sure");
  });

  it("emits RUN_ERROR when the SDK run throws", async () => {
    eventsRef.throwErr = new Error("boom");
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(adapter, baseInput());

    const errorEvent = events.find((e) => e.type === EventType.RUN_ERROR) as any;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe("boom");
  });

  it("converts input messages to SDK input", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    await collectEvents(adapter, baseInput({
      messages: [
        { id: "m1", role: "user", content: "hi" } as any,
        { id: "m2", role: "assistant", content: "hello" } as any,
      ],
    }));

    expect(lastRun.input).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("builds the agent with configured model + instructions", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({
      model: "gpt-5-mini",
      instructions: "You are a pirate",
      agentId: "pirate-agent",
    });
    await collectEvents(adapter, baseInput({ state: null }));

    expect(lastRun.agentConfig).toMatchObject({
      name: "pirate-agent",
      model: "gpt-5-mini",
      instructions: "You are a pirate",
    });
  });

  it("wires converted tools + ag_ui_update_state into the agent when state is present", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    await collectEvents(
      adapter,
      baseInput({
        tools: [
          { name: "get_weather", description: "Get weather", parameters: {} },
        ],
        state: { count: 1 },
      }),
    );

    const tools = lastRun.agentConfig.tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: "get_weather", __mockTool: true });
    expect(tools[1]).toMatchObject({ name: "ag_ui_update_state", __mockTool: true });
  });

  it("wires no state tool when state is absent", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    await collectEvents(
      adapter,
      baseInput({
        tools: [{ name: "only_tool", description: "x", parameters: {} }],
        state: null,
      }),
    );

    const tools = lastRun.agentConfig.tools as unknown[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "only_tool" });
  });
});

describe("OpenAIAgentsAdapter — HITL halt + resume (Phase 5)", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    eventsRef.events = [];
    eventsRef.throwErr = undefined;
    eventsRef.hold = undefined;
    lastRun = { agentConfig: {}, input: undefined, providerCalls: {} } as any;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("halts on a frontend tool and finishes with an interrupt outcome", async () => {
    eventsRef.events = [
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "Let me check the weather" } },
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: { rawItem: { callId: "call_fw", name: "get_weather", arguments: '{"city":"SF"}' } },
      },
      // These should NEVER be reached — the adapter breaks the loop on halt.
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "AFTER HALT" } },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    const events = await collectEvents(
      adapter,
      baseInput({
        tools: [{ name: "get_weather", description: "w", parameters: {} }],
        state: null,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).not.toContain(EventType.TOOL_CALL_RESULT);

    // The "AFTER HALT" delta was never consumed.
    const contentEvents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as any[];
    expect(contentEvents.map((e) => e.delta)).toEqual(["Let me check the weather"]);

    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as any;
    expect(finished.outcome).toEqual({
      type: "interrupt",
      interrupts: [
        { id: "call_fw", reason: "frontend_tool", toolCallId: "call_fw", metadata: { toolName: "get_weather" } },
      ],
    });
  });

  it("finishes without an interrupt for frontend tools that do not resume", async () => {
    eventsRef.events = [
      { type: "run_item_stream_event", name: "tool_called", item: { rawItem: { callId: "haiku-1", name: "generate_haiku", arguments: "{}" } } },
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "AFTER HALT" } },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5", interruptOnFrontendToolCall: false });
    const events = await collectEvents(adapter, baseInput({
      tools: [{ name: "generate_haiku", description: "Render a haiku", parameters: {} }],
    }));

    expect(events.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(true);
    expect(events.some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(false);
    expect(events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(false);
    expect(events.find((event) => event.type === EventType.RUN_FINISHED)).toMatchObject({
      outcome: { type: "success" },
    });
  });

  it("resumes: a tool-result message is fed back as a function_call_result input item", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    await collectEvents(
      adapter,
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "What's the weather?" } as any,
          {
            id: "a1",
            role: "assistant",
            toolCalls: [
              {
                id: "call_fw",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          } as any,
          {
            id: "call_fw",
            role: "tool",
            toolCallId: "call_fw",
            content: "sunny",
          } as any,
        ],
        tools: [{ name: "get_weather", description: "w", parameters: {} }],
        state: null,
      }),
    );

    expect(lastRun.input).toEqual([
      { role: "user", content: "What's the weather?" },
      {
        type: "function_call",
        callId: "call_fw",
        name: "get_weather",
        arguments: '{"city":"SF"}',
        status: "completed",
      },
      {
        type: "function_call_result",
        callId: "call_fw",
        name: "get_weather",
        output: "sunny",
        status: "completed",
      },
    ]);

    // Resumed run completes successfully (no interrupt).
    // (lastRun.input was the SDK input; outcome is asserted via the events in
    // the halt test; here we just confirm the reconstruction path.)
  });

  it("restores the assistant call before a tool result reordered by the Dojo client", async () => {
    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    await collectEvents(
      adapter,
      baseInput({
        messages: [
          { id: "u1", role: "user", content: "Weather in San Francisco" } as any,
          { id: "call_fw", role: "tool", toolCallId: "call_fw", content: "sunny" } as any,
          {
            id: "a1",
            role: "assistant",
            content: "It is sunny.",
            toolCalls: [{
              id: "call_fw",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"San Francisco"}' },
            }],
          } as any,
          { id: "u2", role: "user", content: "Weather in New York" } as any,
        ],
      }),
    );

    expect(lastRun.input).toEqual([
      { role: "user", content: "Weather in San Francisco" },
      { type: "function_call", callId: "call_fw", name: "get_weather", arguments: '{"location":"San Francisco"}', status: "completed" },
      { type: "function_call_result", callId: "call_fw", name: "get_weather", output: "sunny", status: "completed" },
      { role: "assistant", content: "It is sunny." },
      { role: "user", content: "Weather in New York" },
    ]);
  });

  it("hydrates state from the in-memory store across runs on the same thread", async () => {
    // Run 1: state evolves via ag_ui_update_state and is persisted.
    eventsRef.events = [
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          rawItem: {
            callId: "call_s",
            name: "ag_ui_update_state",
            arguments: JSON.stringify({ state: { count: 42 } }),
          },
        },
      },
      { type: "run_item_stream_event", name: "tool_output", item: { rawItem: { callId: "call_s" }, output: "ok" } },
    ];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5" });
    await collectEvents(adapter, baseInput({ threadId: "thread-x", state: { count: 0 } }));

    // Run 2: no state sent — should hydrate { count: 42 } from the store.
    eventsRef.events = [];
    const events = await collectEvents(
      adapter,
      baseInput({ threadId: "thread-x", state: null }),
    );

    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT) as any[];
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0].snapshot).toEqual({ count: 42 });
    expect(lastRun.agentConfig.instructions).toContain('"count":42');
    expect(lastRun.agentConfig.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "ag_ui_update_state" })]),
    );
  });

  it("shares the state store with a clone across runs", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const adapter = new OpenAIAgentsAdapter();
    await collectEvents(adapter, baseInput({ state: { count: 42 } }));
    const events = await collectEvents(adapter.clone(), baseInput({ state: null }));
    expect(events).toContainEqual(expect.objectContaining({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { count: 42 },
    }));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it.each([true, false])("preserves all frontend calls in a model response (interrupt=%s)", async (interrupt) => {
    process.env.OPENAI_API_KEY = "sk-test";
    eventsRef.events = [
      { type: "raw_model_stream_event", data: { type: "response_done", response: { output: [
        { type: "function_call", callId: "a", name: "first" },
        { type: "function_call", callId: "b", name: "second" },
      ] } } },
      { type: "run_item_stream_event", name: "tool_called", item: { rawItem: { callId: "a", name: "first", arguments: "{}" } } },
      { type: "run_item_stream_event", name: "tool_called", item: { rawItem: { callId: "b", name: "second", arguments: "{}" } } },
      { type: "raw_model_stream_event", data: { type: "output_text_delta", delta: "AFTER HALT" } },
    ];
    const adapter = new OpenAIAgentsAdapter({ interruptOnFrontendToolCall: interrupt });
    const events = await collectEvents(adapter, baseInput({
      state: null,
      tools: [
        { name: "first", description: "", parameters: {} },
        { name: "second", description: "", parameters: {} },
      ],
    }));
    expect(events.filter((e) => e.type === EventType.TOOL_CALL_START).map((e) => e.toolCallId)).toEqual(["a", "b"]);
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(false);
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent | undefined;
    expect(snapshot?.messages.find((m) => m.role === "assistant")?.toolCalls?.map((t) => t.id)).toEqual(["a", "b"]);
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as RunFinishedEvent | undefined;
    expect(finished?.outcome?.type).toBe(interrupt ? "interrupt" : "success");
  });

  it("aborts the SDK signal when the subscriber unsubscribes", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const set = vi.fn(async () => {});
    const adapter = new OpenAIAgentsAdapter({
      runStateStore: { get: async () => undefined, set, delete: async () => {} },
    });
    let release!: () => void;
    eventsRef.hold = new Promise<void>((resolve) => { release = resolve; });
    const subscription = adapter.run(baseInput()).subscribe();
    await vi.waitFor(() => expect(lastRun.signal).toBeDefined());
    expect(lastRun.signal).toBeDefined();
    expect(lastRun.signal?.aborted).toBe(false);
    subscription.unsubscribe();
    expect(lastRun.signal?.aborted).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(set).not.toHaveBeenCalled();
  });

  it("does not start model work when unsubscribed during state hydration", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const hydrationStarted = new Promise<void>((resolve) => { started = resolve; });
    const adapter = new OpenAIAgentsAdapter({
      runStateStore: {
        get: async () => { started(); await wait; return undefined; },
        set: async () => {},
        delete: async () => {},
      },
    });
    const sub = adapter.run(baseInput({ state: null })).subscribe();
    await hydrationStarted;
    sub.unsubscribe();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastRun.signal).toBeUndefined();
  });

  it("talks to an injected custom RunStateStore (the DDB/S3 extension seam)", async () => {
    const calls: string[] = [];
    const fakeStore = {
      get: async (threadId: string) => {
        calls.push(`get:${threadId}`);
        return undefined;
      },
      set: async (threadId: string, _state: unknown) => {
        calls.push(`set:${threadId}`);
      },
      delete: async (threadId: string) => {
        calls.push(`delete:${threadId}`);
      },
    };

    eventsRef.events = [];
    process.env.OPENAI_API_KEY = "sk-test";

    const adapter = new OpenAIAgentsAdapter({ model: "gpt-5", runStateStore: fakeStore as any });
    await collectEvents(adapter, baseInput({ threadId: "thread-custom", state: null }));

    // The adapter consulted the store for hydration on this thread.
    expect(calls).toContain("get:thread-custom");
  });
});

describe("OpenAIAgentsAdapter — LiteLLM provider wiring", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    eventsRef.events = [];
    lastRun = { agentConfig: {}, input: undefined, providerCalls: {} } as any;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("uses Chat Completions mode + disables tracing when baseURL is set", async () => {
    eventsRef.events = [];
    const adapter = new OpenAIAgentsAdapter({
      apiKey: "sk-test",
      baseURL: "https://litellm.example.com/v1",
    });
    await collectEvents(adapter, baseInput());

    expect(lastRun.apiMode).toBe("chat_completions");
    expect(lastRun.tracingDisabled).toBe(true);
    expect(lastRun.setClientCalledWith).toBeDefined();
  });

  it("sets the default key on the default cloud path", async () => {
    eventsRef.events = [];
    const adapter = new OpenAIAgentsAdapter({ apiKey: "sk-test" });
    await collectEvents(adapter, baseInput());

    expect(lastRun.setKeyCalledWith).toBe("sk-test");
    expect(lastRun.apiMode).toBeUndefined();
    expect(lastRun.tracingDisabled).toBeUndefined();
  });

  it("accepts a preconfigured openAIClient without baseURL", async () => {
    eventsRef.events = [];
    const fakeClient = { custom: true };
    const adapter = new OpenAIAgentsAdapter({ openAIClient: fakeClient });
    await collectEvents(adapter, baseInput());

    expect(lastRun.setClientCalledWith).toBe(fakeClient);
    expect(lastRun.tracingDisabled).toBe(true);
    // must NOT set chat_completions mode automatically (caller owns the client)
    expect(lastRun.apiMode).toBeUndefined();
  });
});
