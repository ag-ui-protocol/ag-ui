import { describe, it, expect, vi } from "vitest";
import { LangGraphAgent } from "../agent";
import { langchainMessagesToAgui } from "../utils";
import fixture from "../../../../../middlewares/a2ui-middleware/__tests__/fixtures/pni-568-orphan.json";
function buildAgent(checkpointMessages: any[], history: any[]) {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  // Pre-set assistant so prepareStream doesn't need a live search.
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
      getState: vi
        .fn()
        .mockResolvedValue({
          values: { messages: checkpointMessages },
          tasks: [],
        }),
      getHistory: vi.fn().mockResolvedValue(history),
      updateState: vi
        .fn()
        .mockResolvedValue({ checkpoint: { checkpoint_id: "ck-fork" } }),
    },
    assistants: {
      search: vi
        .fn()
        .mockResolvedValue([
          {
            assistant_id: "asst-1",
            graph_id: "test-graph",
            config: { configurable: {} },
          },
        ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
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

  const events: any[] = [];
  (agent as any).subscriber = {
    next: (e: any) => events.push(e),
    error: vi.fn(),
    complete: vi.fn(),
    closed: false,
  };

  return { agent, events, streamCalls };
}

const STREAM_MODE = ["events", "values", "updates", "messages-tuple"] as const;

const result = {
  id: "recovery",
  role: "tool",
  toolCallId: "call_25dQx1aDND8JEi4wmPYlEQ6z",
  content: '{"status":"cancelled","code":"a2ui_unanswered_call"}',
};
describe("PNI-568 native continuation boundary", () => {
  it("sends an atomic history repair to the original thread before the next model request", async () => {
    const { agent, streamCalls } = buildAgent(fixture, []);
    const messages = langchainMessagesToAgui(fixture as any);
    await (agent as any).prepareStream(
      {
        threadId: "thread-1",
        runId: "r",
        messages: [
          ...messages,
          result,
          { id: "new-user", role: "user", content: "Continue" },
        ],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      [...STREAM_MODE],
    );
    const repaired = streamCalls[0].input.messages.__overwrite__;
    expect(
      repaired.filter((m: any) => m.id !== "recovery" && m.id !== "new-user"),
    ).toEqual(fixture);
    expect(repaired.at(-3)).toMatchObject({
      type: "tool",
      tool_call_id: result.toolCallId,
      id: "recovery",
    });
    expect(repaired.at(-2)).toEqual(fixture.at(-1));
    expect((agent as any).client.threads.updateState).not.toHaveBeenCalled();
  });
  it("does not rewrite a checkpoint with a pending native interrupt", async () => {
    const { agent, streamCalls } = buildAgent(fixture, []);
    (agent as any).client.threads.getState.mockResolvedValue({
      values: { messages: fixture },
      tasks: [{ interrupts: [{ id: "approval", value: "Approve?" }] }],
    });
    await (agent as any).prepareStream(
      {
        threadId: "thread-1",
        runId: "r",
        messages: [...langchainMessagesToAgui(fixture as any), result],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      [...STREAM_MODE],
    );
    expect(streamCalls).toHaveLength(0);
    expect((agent as any).client.threads.updateState).not.toHaveBeenCalled();
  });
});
