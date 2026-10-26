import { describe, expect, it, vi } from "vitest";
import { EventType, verifyEvents, type BaseEvent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { LangGraphAgent } from "../agent";

/**
 * A run must not finish while a text message is still open: @ag-ui/client
 * rejects RUN_FINISHED with "Cannot send 'RUN_FINISHED' while text messages
 * are still active". These runs go through verifyEvents, as a client does.
 */

const input: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: "u1", role: "user", content: "Triage my ticket" }],
};

const metadata = {
  run_id: "server-run-1",
  langgraph_node: "triage",
  langgraph_step: 1,
  langgraph_checkpoint_ns: "triage:1",
};

function makeAgent(tuples: unknown[][]) {
  const agent = new LangGraphAgent({
    graphId: "triage",
    deploymentUrl: "http://localhost:8000",
  });
  const client = {
    assistants: {
      search: vi
        .fn()
        .mockResolvedValue([
          { assistant_id: "asst", graph_id: "triage", config: {} },
        ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {} } },
        output_schema: { properties: { messages: {} } },
      }),
    },
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: input.threadId }),
      getState: vi.fn().mockResolvedValue({
        values: { messages: [] },
        next: [],
        tasks: [],
        metadata: {},
      }),
      getHistory: vi.fn().mockResolvedValue([]),
    },
    runs: {
      stream: vi.fn().mockImplementation(async function* () {
        for (const data of tuples) yield { event: "messages", data };
      }),
    },
  };
  Object.assign(agent, { client });
  return agent;
}

async function collect(agent: LangGraphAgent) {
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    agent
      .run(input)
      .pipe(verifyEvents(false))
      .subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: resolve,
      }),
  );
  return events.filter((e) => e.type !== EventType.RAW);
}

describe("a run that leaves no text message open", () => {
  it("finishes when the graph returns a message it did not stream", async () => {
    // The Python LangGraph API's wire form of a node returning
    // AIMessage(content=...) without calling a model.
    const agent = makeAgent([
      [
        {
          type: "ai",
          id: "msg-1",
          content: "Ticket triaged: priority high.",
          additional_kwargs: {},
          response_metadata: {},
          tool_calls: [],
          invalid_tool_calls: [],
        },
        metadata,
      ],
    ]);

    const types = (await collect(agent)).map((e) => e.type);

    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.RUN_FINISHED),
    );
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
  });

  it("finishes when a streamed message never reports a finish reason", async () => {
    const agent = makeAgent([
      [
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          tool_call_chunks: [],
          response_metadata: {},
        },
        metadata,
      ],
    ]);

    const events = await collect(agent);
    const types = events.map((e) => e.type);

    const end = events.find((e) => e.type === EventType.TEXT_MESSAGE_END);
    expect(end).toMatchObject({ messageId: "msg-1" });
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.RUN_FINISHED),
    );
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
  });
});
