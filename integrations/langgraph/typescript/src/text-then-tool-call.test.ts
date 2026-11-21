import { EventType } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { Subscriber } from "rxjs";

import { LangGraphAgent, type ProcessedEvents } from "./agent";

function createAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });
  const events: ProcessedEvents[] = [];
  agent.subscriber = new Subscriber<ProcessedEvents>({
    next: (event: ProcessedEvents) => events.push(event),
    error: (error: unknown) => {
      throw error;
    },
    complete: () => {},
  });
  agent.activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
  };
  return { agent, events };
}

function streamChunk(
  content: unknown[],
  toolCallChunks: unknown[] = [],
  emitToolCalls = true,
) {
  return {
    event: "on_chat_model_stream",
    metadata: { "emit-messages": true, "emit-tool-calls": emitToolCalls },
    data: {
      chunk: {
        id: "msg-1",
        content,
        tool_call_chunks: toolCallChunks,
        response_metadata: {},
      },
    },
  };
}

describe("LangGraphAgent text followed by a tool call in one message", () => {
  it("starts the tool call carried by the chunk that ends the streamed text", () => {
    const { agent, events } = createAgent();

    // Anthropic content-block streaming: a text block, then a tool_use block
    // with empty args, then input_json_delta chunks, then the end chunk.
    const chunks = [
      streamChunk([
        { type: "text", text: "Building the dashboard.", index: 0 },
      ]),
      streamChunk(
        [
          {
            type: "tool_use",
            id: "call-1",
            name: "render_ui",
            input: {},
            index: 1,
          },
        ],
        [
          {
            name: "render_ui",
            args: "",
            id: "call-1",
            index: 1,
            type: "tool_call_chunk",
          },
        ],
      ),
      streamChunk(
        [
          {
            type: "input_json_delta",
            partial_json: '{"surfaceId":"x"}',
            index: 1,
          },
        ],
        [
          {
            name: null,
            args: '{"surfaceId":"x"}',
            id: null,
            index: 1,
            type: "tool_call_chunk",
          },
        ],
      ),
      streamChunk([]),
    ];
    for (const chunk of chunks) agent.handleSingleEvent(chunk);

    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    expect(events[3]).toMatchObject({
      toolCallId: "call-1",
      toolCallName: "render_ui",
    });
    expect(events[4]).toMatchObject({
      toolCallId: "call-1",
      delta: '{"surfaceId":"x"}',
    });
    expect(agent.activeRun?.hasFunctionStreaming).toBe(true);
  });

  it.each([
    ["complete arguments", '{"surfaceId":"x"}', ""],
    ["an initial argument fragment", '{"surfaceId":', '"x"}'],
  ])("preserves %s on the first named tool chunk", (_label, initial, rest) => {
    const { agent, events } = createAgent();
    agent.handleSingleEvent(
      streamChunk([{ type: "text", text: "Building the dashboard." }]),
    );
    agent.handleSingleEvent(
      streamChunk(
        [],
        [{ id: "call-1", name: "render_ui", args: initial, index: 0 }],
      ),
    );
    if (rest) {
      agent.handleSingleEvent(streamChunk([], [{ args: rest, index: 0 }]));
    }
    agent.handleSingleEvent({ event: "on_chat_model_end" });

    const toolEvents = events.filter(
      (event) =>
        event.type === EventType.TOOL_CALL_START ||
        event.type === EventType.TOOL_CALL_ARGS ||
        event.type === EventType.TOOL_CALL_END,
    );
    expect(toolEvents.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      ...(rest ? [EventType.TOOL_CALL_ARGS] : []),
      EventType.TOOL_CALL_END,
    ]);
    expect(toolEvents.every((event) => event.toolCallId === "call-1")).toBe(
      true,
    );
    expect(toolEvents[0]).toMatchObject({ parentMessageId: "msg-1" });
    expect(
      toolEvents
        .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
        .map((event) => event.delta)
        .join(""),
    ).toBe('{"surfaceId":"x"}');

    const eventCount = events.length;
    agent.handleSingleEvent({
      event: "on_tool_end",
      data: {
        input: { surfaceId: "x" },
        output: { tool_call_id: "call-1", name: "render_ui", content: "Done" },
      },
    });
    expect(events.slice(eventCount).map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(agent.getMessageInProgress("run-1")).toBeNull();
  });

  it.each([false, true])(
    "keeps consecutive tool blocks separate (initial args: %s) without replaying them",
    (initialArgs) => {
      const { agent, events } = createAgent();
      agent.handleSingleEvent(
        streamChunk([{ type: "text", text: "Building two dashboards." }]),
      );
      for (const [index, surfaceId] of ["x", "y"].entries()) {
        const id = `call-${index + 1}`;
        agent.handleSingleEvent(
          streamChunk(
            [{ type: "tool_use", id, name: "render_ui", input: {}, index }],
            [
              {
                id,
                name: "render_ui",
                args: initialArgs ? JSON.stringify({ surfaceId }) : "",
                index,
              },
            ],
          ),
        );
        if (!initialArgs) {
          agent.handleSingleEvent(
            streamChunk([], [{ args: JSON.stringify({ surfaceId }), index }]),
          );
        }
      }
      agent.handleSingleEvent({ event: "on_chat_model_end" });

      const toolEvents = events.filter(
        (event) =>
          event.type === EventType.TOOL_CALL_START ||
          event.type === EventType.TOOL_CALL_ARGS ||
          event.type === EventType.TOOL_CALL_END,
      );
      expect(toolEvents.map((event) => [event.type, event.toolCallId])).toEqual(
        [
          [EventType.TOOL_CALL_START, "call-1"],
          [EventType.TOOL_CALL_ARGS, "call-1"],
          [EventType.TOOL_CALL_END, "call-1"],
          [EventType.TOOL_CALL_START, "call-2"],
          [EventType.TOOL_CALL_ARGS, "call-2"],
          [EventType.TOOL_CALL_END, "call-2"],
        ],
      );
      expect(toolEvents[1]).toMatchObject({ delta: '{"surfaceId":"x"}' });
      expect(toolEvents[4]).toMatchObject({ delta: '{"surfaceId":"y"}' });

      const eventCount = events.length;
      for (const [index, surfaceId] of ["x", "y"].entries()) {
        agent.handleSingleEvent({
          event: "on_tool_end",
          data: {
            input: { surfaceId },
            output: {
              tool_call_id: `call-${index + 1}`,
              name: "render_ui",
              content: "Done",
            },
          },
        });
      }
      expect(events.slice(eventCount).map((event) => event.type)).toEqual([
        EventType.TOOL_CALL_RESULT,
        EventType.TOOL_CALL_RESULT,
      ]);
      expect(agent.getMessageInProgress("run-1")).toBeNull();
    },
  );
  it("appends arguments when a chunk repeats the same tool ID and name", () => {
    const { agent, events } = createAgent();
    agent.handleSingleEvent(streamChunk([{ type: "text", text: "Building." }]));
    for (const args of ['{"surfaceId":', '"x"}']) {
      agent.handleSingleEvent(
        streamChunk([], [{ id: "call-1", name: "render_ui", args, index: 0 }]),
      );
    }
    agent.handleSingleEvent({ event: "on_chat_model_end" });

    expect(events.slice(3)).toMatchObject([
      { type: EventType.TOOL_CALL_START, toolCallId: "call-1" },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: '{"surfaceId":',
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '"x"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
    ]);
  });

  it("ends text without emitting suppressed tool calls", () => {
    const { agent, events } = createAgent();
    agent.handleSingleEvent(
      streamChunk([{ type: "text", text: "Building." }], [], false),
    );
    agent.handleSingleEvent(
      streamChunk(
        [],
        [{ id: "call-1", name: "render_ui", args: '{"surfaceId":', index: 0 }],
        false,
      ),
    );
    agent.handleSingleEvent(
      streamChunk([], [{ args: '"x"}', index: 0 }], false),
    );
    agent.handleSingleEvent({ event: "on_chat_model_end" });

    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(agent.getMessageInProgress("run-1")).toBeNull();
  });

  it("preserves a text-only stream", () => {
    const { agent, events } = createAgent();
    for (const text of ["Hello", " world"]) {
      agent.handleSingleEvent(streamChunk([{ type: "text", text }]));
    }
    agent.handleSingleEvent({ event: "on_chat_model_end" });

    expect(events).toMatchObject([
      { type: EventType.TEXT_MESSAGE_START, messageId: "msg-1" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: " world",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" },
    ]);
    expect(agent.getMessageInProgress("run-1")).toBeNull();
  });
});
