/**
 * Regression tests for #2173: on a resume, the TypeScript LangGraph adapter
 * must send `command` WITHOUT `input`.
 *
 * `input` ("start a run with this state") and `command` ("resume the paused
 * run with this value") are mutually exclusive server-side; Aegra rejects the
 * pair with HTTP 422. The Python adapter is already exclusive -- in
 * `prepare_stream` a resume builds `Command(resume=...)` and never calls
 * `get_stream_payload_input` (ag_ui_langgraph/agent.py). These tests pin the
 * same behavior for TypeScript, and pin the non-resume paths so the fix does
 * not change what a normal start / continue sends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LangGraphAgent } from "../agent";

function buildAgent(opts: { tasks?: any[]; nodeName?: string } = {}) {
  const checkpointMessages = [
    { type: "human", id: "h1", content: "schedule a meeting" },
    { type: "ai", id: "ai1", content: "which time?" },
  ];

  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    nodeName: opts.nodeName,
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  (agent as any).assistant = {
    assistant_id: "asst-1",
    graph_id: "test-graph",
    config: { configurable: {} },
  };

  const streamCalls: any[] = [];
  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue({
        values: { messages: checkpointMessages },
        tasks: opts.tasks ?? [],
      }),
      getHistory: vi.fn().mockResolvedValue([]),
      updateState: vi
        .fn()
        .mockResolvedValue({ checkpoint: { checkpoint_id: "ck-1" } }),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([
        {
          assistant_id: "asst-1",
          graph_id: "test-graph",
          config: { configurable: {} },
        },
      ]),
      getGraph: vi.fn().mockResolvedValue({
        nodes: [{ id: "agent" }, { id: "ask_human" }],
        edges: [{ source: "agent", target: "ask_human" }],
      }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {}, tools: {} } },
        output_schema: { properties: { messages: {}, tools: {} } },
      }),
    },
    runs: {
      stream: vi
        .fn()
        .mockImplementation((_t: string, _a: string, payload: any) => {
          streamCalls.push(payload);
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => ({ done: true, value: undefined }) };
            },
          };
        }),
    },
  };

  (agent as any).subscriber = {
    next: vi.fn(),
    error: vi.fn(),
    complete: vi.fn(),
    closed: false,
  };

  return { agent, streamCalls };
}

const STREAM_MODE = ["events", "values", "updates", "messages-tuple"] as const;

const INTERRUPT_TASKS = [
  {
    id: "task-1",
    name: "ask_human",
    interrupts: [{ id: "int-1", value: { question: "which time?" } }],
  },
];

function baseInput() {
  return {
    runId: "run-1",
    threadId: "thread-1",
    messages: [
      { id: "h1", role: "user", content: "schedule a meeting" },
      { id: "ai1", role: "assistant", content: "which time?" },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

describe("#2173: resume sends command without input", () => {
  let warn: any;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("omits input when resuming via RunAgentInput.resume[]", async () => {
    const { agent, streamCalls } = buildAgent({
      tasks: INTERRUPT_TASKS,
      nodeName: "ask_human",
    });

    await agent.prepareStream(
      {
        ...baseInput(),
        resume: [
          {
            interruptId: "int-1",
            status: "resolved",
            payload: { time: "3pm" },
          },
        ],
      } as any,
      STREAM_MODE as any,
    );

    expect(streamCalls).toHaveLength(1);
    const payload = streamCalls[0];
    expect(payload.command).toBeTruthy();
    expect(payload.command.resume).toEqual({ time: "3pm" });
    // The defect: `input` carried the full state alongside `command`.
    expect(payload.input ?? null).toBeNull();
  });

  it("omits input when resuming via the legacy forwardedProps.command.resume", async () => {
    const { agent, streamCalls } = buildAgent({
      tasks: INTERRUPT_TASKS,
      nodeName: "ask_human",
    });

    await agent.prepareStream(
      {
        ...baseInput(),
        forwardedProps: { command: { resume: { time: "3pm" } } },
      } as any,
      STREAM_MODE as any,
    );

    expect(streamCalls).toHaveLength(1);
    const payload = streamCalls[0];
    expect(payload.command.resume).toEqual({ time: "3pm" });
    expect(payload.input ?? null).toBeNull();
  });

  it("still sends input on a normal start (no resume, no resumable node)", async () => {
    const { agent, streamCalls } = buildAgent();

    await agent.prepareStream(baseInput() as any, STREAM_MODE as any);

    expect(streamCalls).toHaveLength(1);
    const payload = streamCalls[0];
    expect(payload.command).toBeUndefined();
    expect(payload.input).toBeTruthy();
    expect(Array.isArray(payload.input.messages)).toBe(true);
    expect(payload.input.messages.length).toBeGreaterThan(0);
  });

  it("still sends a null input on a non-resume continuation", async () => {
    const { agent, streamCalls } = buildAgent({ nodeName: "ask_human" });

    await agent.prepareStream(baseInput() as any, STREAM_MODE as any);

    expect(streamCalls).toHaveLength(1);
    const payload = streamCalls[0];
    expect(payload.command).toBeUndefined();
    expect(payload.input ?? null).toBeNull();
    // The continuation still seeds state through updateState, not through input.
    expect((agent as any).client.threads.updateState).toHaveBeenCalled();
  });
});
