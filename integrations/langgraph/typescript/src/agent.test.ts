import { Subscriber, Observable } from "rxjs";
import { EventType } from "@ag-ui/client";
import { LangGraphAgent } from "./agent";
import type { ProcessedEvents } from "./types";

/**
 * Helper: create a LangGraphAgent with a minimal mock client.
 * The mock client stubs out API calls so we can test event handling logic
 * without hitting a real LangGraph deployment.
 */
function createTestAgent(overrides?: Partial<ConstructorParameters<typeof LangGraphAgent>[0]>) {
  return new LangGraphAgent({
    deploymentUrl: "http://localhost:8000",
    graphId: "test-graph",
    ...overrides,
  });
}

/**
 * Helper: set up an agent with an activeRun and subscriber so we can call
 * handleSingleEvent / handleMessagesTupleEvent directly and collect dispatched events.
 */
function setupAgentForEventHandling() {
  const agent = createTestAgent();
  const events: ProcessedEvents[] = [];
  const subscriber = {
    next: (event: ProcessedEvents) => events.push(event),
    error: () => {},
    complete: () => {},
  } as unknown as Subscriber<ProcessedEvents>;

  agent.subscriber = subscriber;
  (agent as any).activeRun = {
    id: "test-run",
    threadId: "test-thread",
    hasFunctionStreaming: false,
  };
  (agent as any).messagesInProcess = {};

  return { agent, events };
}

describe("LangGraphAgent", () => {
  describe("default stream modes", () => {
    it("includes messages-tuple in default stream modes", async () => {
      const agent = createTestAgent();

      // Pre-set assistant to skip the API call
      (agent as any).assistant = { assistant_id: "test-assistant", graph_id: "test-graph" };

      let capturedStreamMode: any;
      // Override prepareStream to capture the stream mode that was passed
      (agent as any).prepareStream = async (input: any, streamMode: any) => {
        capturedStreamMode = streamMode;
        return null; // Will cause early return
      };

      const subscriber = {
        next: () => {},
        error: () => {},
        complete: () => {},
      } as unknown as Subscriber<ProcessedEvents>;

      await agent.runAgentStream({ runId: "run-1", threadId: "thread-1" } as any, subscriber);

      expect(capturedStreamMode).toEqual(["events", "values", "updates", "messages-tuple"]);
    });

    it("respects custom streamMode from forwardedProps", async () => {
      const agent = createTestAgent();
      (agent as any).assistant = { assistant_id: "test-assistant", graph_id: "test-graph" };

      let capturedStreamMode: any;
      (agent as any).prepareStream = async (input: any, streamMode: any) => {
        capturedStreamMode = streamMode;
        return null;
      };

      const subscriber = {
        next: () => {},
        error: () => {},
        complete: () => {},
      } as unknown as Subscriber<ProcessedEvents>;

      await agent.runAgentStream(
        {
          runId: "run-1",
          threadId: "thread-1",
          forwardedProps: { streamMode: ["events", "values"] },
        } as any,
        subscriber,
      );

      expect(capturedStreamMode).toEqual(["events", "values"]);
    });
  });

  describe("handleMessagesTupleEvent", () => {
    it("emits TEXT_MESSAGE_START and TEXT_MESSAGE_CONTENT for text chunks", () => {
      const { agent, events } = setupAgentForEventHandling();

      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_START,
          role: "assistant",
          messageId: "msg-1",
        }),
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "Hello",
        }),
      );
    });

    it("streams multiple text content chunks under the same message", () => {
      const { agent, events } = setupAgentForEventHandling();

      // First chunk starts the message
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      // Second chunk continues the message
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: " world",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((events[2] as any).delta).toBe(" world");
    });

    it("emits TEXT_MESSAGE_END on finish_reason stop", () => {
      const { agent, events } = setupAgentForEventHandling();

      // Start a message
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      // Finish the message
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [],
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      expect(events).toHaveLength(3);
      expect(events[2]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_END,
          messageId: "msg-1",
        }),
      );
    });

    it("emits TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END for tool calls", () => {
      const { agent, events } = setupAgentForEventHandling();

      // Tool call start
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      // Tool call args
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ args: '{"query":' }],
          response_metadata: {},
        },
        {},
      ]);

      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ args: '"test"}' }],
          response_metadata: {},
        },
        {},
      ]);

      // Finish
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [],
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      expect(events).toHaveLength(4);
      expect(events[0]).toEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc-1",
          toolCallName: "search",
        }),
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "tc-1",
          delta: '{"query":',
        }),
      );
      expect(events[2]).toEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "tc-1",
          delta: '"test"}',
        }),
      );
      expect(events[3]).toEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_END,
          toolCallId: "tc-1",
        }),
      );
    });

    it("ends text message before starting a tool call", () => {
      const { agent, events } = setupAgentForEventHandling();

      // Text message
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Let me search",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      // Tool call starts (should end text message first)
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-2",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_END); // auto-ended
      expect(events[3].type).toBe(EventType.TOOL_CALL_START);
    });

    it("handles finish_reason tool_calls to end tool calls", () => {
      const { agent, events } = setupAgentForEventHandling();

      // Tool call start
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      // Tool call args
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ args: '{"q":"test"}' }],
          response_metadata: {},
        },
        {},
      ]);

      // Finish with tool_calls reason (not "stop")
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [],
          response_metadata: { finish_reason: "tool_calls" },
        },
        {},
      ]);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(events[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(events[2]).toEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_END,
          toolCallId: "tc-1",
        }),
      );
    });

    it("starts a new text message after a tool call completes", () => {
      const { agent, events } = setupAgentForEventHandling();

      // Tool call flow
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ args: '{"q":"test"}' }],
          response_metadata: {},
        },
        {},
      ]);

      // Tool call finishes
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [],
          response_metadata: { finish_reason: "tool_calls" },
        },
        {},
      ]);

      // New AI message with text after tool execution
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-2",
          content: "Based on the results",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      // Should have: TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT
      expect(events).toHaveLength(5);
      expect(events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(events[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(events[2].type).toBe(EventType.TOOL_CALL_END);
      expect(events[3]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_START,
          role: "assistant",
          messageId: "ai-msg-2",
        }),
      );
      expect(events[4]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "ai-msg-2",
          delta: "Based on the results",
        }),
      );
    });

    it("starts a new text message when text arrives and tracker has stale tool call context", () => {
      const { agent, events } = setupAgentForEventHandling();

      // Simulate stale tracker state (tool call context that wasn't cleaned up)
      (agent as any)._messagesTupleTracker = { messageId: "old-msg", toolCallId: "old-tc" };

      // New text content arrives
      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "new-msg",
          content: "Fresh response",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_START,
          messageId: "new-msg",
        }),
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "new-msg",
          delta: "Fresh response",
        }),
      );
    });

    it("skips non-AI message chunks", () => {
      const { agent, events } = setupAgentForEventHandling();

      (agent as any).handleMessagesTupleEvent([
        {
          type: "HumanMessageChunk",
          id: "human-1",
          content: "user message",
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(0);
    });

    it("skips non-array data", () => {
      const { agent, events } = setupAgentForEventHandling();

      (agent as any).handleMessagesTupleEvent({ not: "an array" });

      expect(events).toHaveLength(0);
    });

    it("skips empty initialization chunks", () => {
      const { agent, events } = setupAgentForEventHandling();

      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(0);
    });

    it("handles content as array with text type", () => {
      const { agent, events } = setupAgentForEventHandling();

      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: [
            { type: "text", text: "Array content" },
          ],
          tool_call_chunks: [],
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(2);
      expect(events[1]).toEqual(
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Array content",
        }),
      );
    });

    it("sets hasFunctionStreaming when tool calls are received", () => {
      const { agent } = setupAgentForEventHandling();

      expect((agent as any).activeRun.hasFunctionStreaming).toBe(false);

      (agent as any).handleMessagesTupleEvent([
        {
          type: "AIMessageChunk",
          id: "ai-msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      expect((agent as any).activeRun.hasFunctionStreaming).toBe(true);
    });
  });

  describe("events-mode dedup", () => {
    it("sets _eventsStreamActive when on_chat_model_stream event is received", () => {
      const { agent } = setupAgentForEventHandling();

      expect((agent as any)._eventsStreamActive).toBe(false);

      agent.handleSingleEvent({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "chunk-1",
            content: "Hello",
            response_metadata: { finish_reason: null },
            tool_call_chunks: [],
          },
        },
      });

      expect((agent as any)._eventsStreamActive).toBe(true);
    });

    it("resets _eventsStreamActive on new runAgentStream call", async () => {
      const agent = createTestAgent();
      (agent as any).assistant = { assistant_id: "test-assistant", graph_id: "test-graph" };
      (agent as any)._eventsStreamActive = true;

      (agent as any).prepareStream = async () => null;

      const subscriber = {
        next: () => {},
        error: () => {},
        complete: () => {},
      } as unknown as Subscriber<ProcessedEvents>;

      await agent.runAgentStream({ runId: "run-1", threadId: "thread-1" } as any, subscriber);

      expect((agent as any)._eventsStreamActive).toBe(false);
    });

    it("resets _messagesTupleTracker on new runAgentStream call", async () => {
      const agent = createTestAgent();
      (agent as any).assistant = { assistant_id: "test-assistant", graph_id: "test-graph" };
      (agent as any)._messagesTupleTracker = { messageId: "old-msg" };

      (agent as any).prepareStream = async () => null;

      const subscriber = {
        next: () => {},
        error: () => {},
        complete: () => {},
      } as unknown as Subscriber<ProcessedEvents>;

      await agent.runAgentStream({ runId: "run-1", threadId: "thread-1" } as any, subscriber);

      expect((agent as any)._messagesTupleTracker).toEqual({});
    });
  });

  describe("handleStreamEvents filter", () => {
    it("allows messages events through when messages-tuple is in streamModes", async () => {
      const { agent, events } = setupAgentForEventHandling();

      // Set up graphInfo so node change handling doesn't error
      (agent as any).activeRun.graphInfo = { nodes: [] };

      // Create a minimal async iterable that yields a messages event then a values event
      const streamChunks = [
        { event: "messages", data: [
          {
            type: "AIMessageChunk",
            id: "msg-1",
            content: "Hello",
            tool_call_chunks: [],
            response_metadata: {},
          },
          {},
        ]},
        // Need values event so state is populated
        { event: "values", data: { messages: [] } },
      ];

      async function* fakeStream() {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      }

      const mockStream = {
        streamResponse: fakeStream(),
        state: { values: {}, metadata: {} },
      };

      // Mock client.threads.getState to return final state
      (agent as any).client = {
        threads: {
          getState: async () => ({
            values: {},
            metadata: { writes: {} },
            next: [],
            tasks: [],
          }),
        },
        runs: { cancel: async () => {} },
      };

      await agent.handleStreamEvents(
        mockStream as any,
        "thread-1",
        agent.subscriber,
        { runId: "run-1" } as any,
        ["events", "values", "updates", "messages-tuple"],
      );

      // Should have processed the messages event
      const textEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START || e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("filters out messages events when messages-tuple is NOT in streamModes", async () => {
      const { agent, events } = setupAgentForEventHandling();
      (agent as any).activeRun.graphInfo = { nodes: [] };

      const streamChunks = [
        { event: "messages", data: [
          {
            type: "AIMessageChunk",
            id: "msg-1",
            content: "Hello",
            tool_call_chunks: [],
            response_metadata: {},
          },
          {},
        ]},
        { event: "values", data: { messages: [] } },
      ];

      async function* fakeStream() {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      }

      const mockStream = {
        streamResponse: fakeStream(),
        state: { values: {}, metadata: {} },
      };

      (agent as any).client = {
        threads: {
          getState: async () => ({
            values: {},
            metadata: { writes: {} },
            next: [],
            tasks: [],
          }),
        },
        runs: { cancel: async () => {} },
      };

      await agent.handleStreamEvents(
        mockStream as any,
        "thread-1",
        agent.subscriber,
        { runId: "run-1" } as any,
        ["events", "values", "updates"], // no messages-tuple
      );

      // Messages event should be filtered out — no text events
      const textEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START || e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(textEvents).toHaveLength(0);
    });

    it("skips messages-tuple events when _eventsStreamActive is true", async () => {
      const { agent, events } = setupAgentForEventHandling();
      (agent as any).activeRun.graphInfo = { nodes: [] };

      // Simulate events mode already producing data
      (agent as any)._eventsStreamActive = true;

      const streamChunks = [
        { event: "messages", data: [
          {
            type: "AIMessageChunk",
            id: "msg-1",
            content: "Duplicate",
            tool_call_chunks: [],
            response_metadata: {},
          },
          {},
        ]},
        { event: "values", data: { messages: [] } },
      ];

      async function* fakeStream() {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      }

      const mockStream = {
        streamResponse: fakeStream(),
        state: { values: {}, metadata: {} },
      };

      (agent as any).client = {
        threads: {
          getState: async () => ({
            values: {},
            metadata: { writes: {} },
            next: [],
            tasks: [],
          }),
        },
        runs: { cancel: async () => {} },
      };

      await agent.handleStreamEvents(
        mockStream as any,
        "thread-1",
        agent.subscriber,
        { runId: "run-1" } as any,
        ["events", "values", "updates", "messages-tuple"],
      );

      // Messages-tuple events should be skipped because _eventsStreamActive
      const textEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_START || e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(textEvents).toHaveLength(0);
    });
  });
});
