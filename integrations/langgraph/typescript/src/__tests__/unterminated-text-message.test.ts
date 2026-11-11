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

/**
 * Runs the agent, presses stop after `beforeStop` chunks have streamed, and
 * returns what a client saw. `saved` is what LangGraph kept for the thread: a
 * cancelled run saves nothing of the message it was streaming.
 */
async function runAndCancel(beforeStop: unknown[], afterStop: unknown[]) {
  const accepted: string[] = [];
  const agent = makeAgent([]);
  const client = (agent as any).client;
  client.runs.cancel = vi.fn(async (_threadId: string, runId: string) => {
    accepted.push(runId);
  });
  client.threads.getState.mockResolvedValue({
    values: {
      messages: [{ type: "human", id: "u1", content: "Triage my ticket" }],
    },
    next: [],
    tasks: [],
    metadata: {},
  });
  client.runs.stream = vi.fn().mockImplementation(async function* () {
    for (const data of beforeStop) yield { event: "messages", data };
    agent.abortRun();
    for (const data of afterStop) yield { event: "messages", data };
  });

  const events: BaseEvent[] = [];
  const onToolCallEndEvent = vi.fn();
  agent.messages = input.messages;
  await agent.runAgent(
    { runId: input.runId },
    {
      onEvent: ({ event }) => {
        events.push(event);
      },
      onToolCallEndEvent,
    },
  );
  return { agent, accepted, events, onToolCallEndEvent };
}

describe("a run that is cancelled mid message", () => {
  const toolChunk = (tool_call_chunks: unknown[]) => [
    {
      type: "AIMessageChunk",
      id: "msg-1",
      content: "",
      tool_call_chunks,
      response_metadata: {},
    },
    metadata,
  ];
  const textChunk = (content: string) => [
    {
      type: "AIMessageChunk",
      id: "msg-1",
      content,
      tool_call_chunks: [],
      response_metadata: {},
    },
    metadata,
  ];

  it("does not end a half-streamed tool call, and drops it from the messages", async () => {
    const { agent, accepted, events, onToolCallEndEvent } = await runAndCancel(
      [
        toolChunk([{ id: "tc-1", name: "send_email", args: "" }]),
        toolChunk([{ args: '{"to":"a@' }]),
      ],
      [toolChunk([{ args: 'b.c"}' }])],
    );

    expect(accepted).toEqual([metadata.run_id]);
    expect(onToolCallEndEvent).not.toHaveBeenCalled();
    const types = events.map((e) => e.type).filter((t) => t !== EventType.RAW);
    expect(types).not.toContain(EventType.TOOL_CALL_END);
    expect(types).not.toContain(EventType.RUN_FINISHED);
    expect(types.slice(-2)).toEqual([
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_ERROR,
    ]);
    expect(events.at(-1)).toMatchObject({ code: "abort" });
    // The third args chunk arrived after the stop and was not forwarded.
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_ARGS),
    ).toHaveLength(1);
    // The cut-off arguments would fail to parse on the next run.
    expect(agent.messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("keeps a half-streamed text message", async () => {
    const { agent, events } = await runAndCancel(
      [textChunk("Ticket triaged: prio")],
      [textChunk("rity high.")],
    );

    const types = events.map((e) => e.type).filter((t) => t !== EventType.RAW);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types.at(-1)).toBe(EventType.RUN_ERROR);
    expect(agent.messages.at(-1)).toMatchObject({
      id: "msg-1",
      content: "Ticket triaged: prio",
    });
  });
});
