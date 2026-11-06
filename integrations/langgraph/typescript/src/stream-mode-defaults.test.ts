/**
 * The default set of LangGraph stream modes (ag-ui #2600).
 *
 * `handleStreamEvents` discards every `updates` chunk outright, so requesting
 * the mode by default costs backend serialization and wire bytes for data the
 * handler never reads. The default no longer asks for it. A caller that passes
 * its own `forwardedProps.streamMode` is still honoured verbatim, including
 * when that set contains `"updates"`.
 */
import { describe, it, expect, vi } from "vitest";
import { Subscriber } from "rxjs";
import { LangGraphAgent } from "./agent";

function buildAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

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
        .mockResolvedValue({ values: { messages: [] }, tasks: [] }),
      getHistory: vi.fn().mockResolvedValue([]),
      updateState: vi
        .fn()
        .mockResolvedValue({ checkpoint: { checkpoint_id: "ck-fork" } }),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([
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

  return { agent, streamCalls };
}

async function runOnce(forwardedProps: Record<string, unknown>) {
  const { agent, streamCalls } = buildAgent();
  const subscriber = new Subscriber<any>({
    next: () => {},
    error: () => {},
    complete: () => {},
  });

  await (agent as any).runAgentStream(
    {
      runId: "run-1",
      threadId: "thread-1",
      messages: [{ id: "h1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps,
    },
    subscriber,
  );

  expect(streamCalls).toHaveLength(1);
  const requested = streamCalls[0].streamMode;
  return Array.isArray(requested) ? requested : [requested];
}

describe("default LangGraph stream modes", () => {
  it("does not request 'updates' by default", async () => {
    const modes = await runOnce({});
    expect(modes).not.toContain("updates");
    // The modes the handler actually reads are still requested.
    expect(modes).toEqual(
      expect.arrayContaining(["events", "values", "messages-tuple"]),
    );
  });

  it("honours a caller-supplied streamMode that includes 'updates'", async () => {
    const modes = await runOnce({
      streamMode: ["events", "values", "updates", "messages-tuple"],
    });
    expect(modes).toEqual(["events", "values", "updates", "messages-tuple"]);
  });

  it("honours a caller-supplied streamMode that omits 'updates'", async () => {
    const modes = await runOnce({ streamMode: ["events"] });
    expect(modes).toEqual(["events"]);
  });
});
