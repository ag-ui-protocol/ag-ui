/**
 * Tests for messages-tuple stream mode support.
 *
 * When "events" stream mode doesn't produce on_chat_model_stream events
 * (e.g., LangGraph Platform with create_agent), the "messages-tuple" stream
 * mode provides streaming via [AIMessageChunk, metadata] tuples.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/client";

// Minimal config to construct the agent
function createAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    url: "http://localhost:8000",
  });

  // Wire up a mock subscriber and activeRun so dispatchEvent works
  const events: any[] = [];
  (agent as any).subscriber = { next: (e: any) => events.push(e) };
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
  };
  (agent as any).messagesInProcess = {};

  return { agent, events };
}

describe("messages-tuple stream mode", () => {
  describe("handleSingleEvent routing", () => {
    it("routes array events to handleMessagesTupleEvent when events mode is inactive", () => {
      const { agent, events } = createAgent();

      const chunk = [
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          response_metadata: {},
        },
        {},
      ];

      agent.handleSingleEvent(chunk);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
    });

    it("skips array events when events mode is active", () => {
      const { agent, events } = createAgent();

      // Simulate events mode producing data
      agent.handleSingleEvent({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-0",
            content: "test",
            response_metadata: { finish_reason: null },
          },
        },
      });
      const eventCountAfterEventsMode = events.length;

      // Now a messages-tuple array should be skipped
      agent.handleSingleEvent([
        { type: "AIMessageChunk", id: "msg-1", content: "Hello", response_metadata: {} },
        {},
      ]);

      expect(events.length).toBe(eventCountAfterEventsMode);
    });

    it("passes non-array events through to parent handler", () => {
      const { agent, events } = createAgent();

      // A regular events-mode event should work normally
      agent.handleSingleEvent({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true, "emit-tool-calls": true },
        data: {
          chunk: {
            id: "msg-1",
            content: "Hello",
            response_metadata: {},
          },
        },
      });

      expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_START)).toBe(true);
    });
  });

  describe("handleMessagesTupleEvent text streaming", () => {
    it("emits TEXT_MESSAGE_START + CONTENT for first text chunk", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "Hello",
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: EventType.TEXT_MESSAGE_START,
        role: "assistant",
        messageId: "msg-1",
      });
      expect(events[1]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello",
      });
    });

    it("emits only CONTENT for subsequent text chunks", () => {
      const { agent, events } = createAgent();

      // First chunk starts the message
      agent.handleSingleEvent([
        { type: "AIMessageChunk", id: "msg-1", content: "Hello", response_metadata: {} },
        {},
      ]);
      // Second chunk continues
      agent.handleSingleEvent([
        { type: "AIMessageChunk", id: "msg-1", content: " world", response_metadata: {} },
        {},
      ]);

      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: " world",
      });
    });

    it("emits TEXT_MESSAGE_END on finish", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEvent([
        { type: "AIMessageChunk", id: "msg-1", content: "Hello", response_metadata: {} },
        {},
      ]);
      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      const endEvents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_END);
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].messageId).toBe("msg-1");
    });
  });

  describe("handleMessagesTupleEvent tool call streaming", () => {
    it("emits TOOL_CALL_START + ARGS for tool call chunks", () => {
      const { agent, events } = createAgent();

      // Tool call start
      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events[0]).toMatchObject({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "search",
      });

      // Tool call args
      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ args: '{"query":' }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events[1]).toMatchObject({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
        delta: '{"query":',
      });
    });

    it("emits TOOL_CALL_END on finish after tool call", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);
      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: { finish_reason: "stop" },
        },
        {},
      ]);

      const endEvents = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].toolCallId).toBe("tc-1");
    });
  });

  describe("handleMessagesTupleEvent edge cases", () => {
    it("skips non-AI chunks", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEvent([
        { type: "HumanMessage", id: "msg-1", content: "Hello" },
        {},
      ]);

      expect(events).toHaveLength(0);
    });

    it("skips empty initialization chunks", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          response_metadata: {},
        },
        {},
      ]);

      expect(events).toHaveLength(0);
    });

    it("handles content as array with text block", () => {
      const { agent, events } = createAgent();

      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: [{ type: "text", text: "Hello from array" }],
          response_metadata: {},
        },
        {},
      ]);

      expect(events[1]).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Hello from array",
      });
    });

    it("ends text message when tool call starts mid-stream", () => {
      const { agent, events } = createAgent();

      // Start text
      agent.handleSingleEvent([
        { type: "AIMessageChunk", id: "msg-1", content: "Let me search", response_metadata: {} },
        {},
      ]);

      // Tool call starts — should end the text message first
      agent.handleSingleEvent([
        {
          type: "AIMessageChunk",
          id: "msg-1",
          content: "",
          tool_call_chunks: [{ id: "tc-1", name: "search", args: "" }],
          response_metadata: {},
        },
        {},
      ]);

      const textEnd = events.find((e) => e.type === EventType.TEXT_MESSAGE_END);
      const toolStart = events.find((e) => e.type === EventType.TOOL_CALL_START);
      expect(textEnd).toBeDefined();
      expect(toolStart).toBeDefined();

      // Text end should come before tool start
      const textEndIdx = events.indexOf(textEnd);
      const toolStartIdx = events.indexOf(toolStart);
      expect(textEndIdx).toBeLessThan(toolStartIdx);
    });
  });
});
