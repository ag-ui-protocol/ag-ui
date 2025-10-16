import { EventType, ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent } from "@ag-ui/core";
import { expect, describe, it } from "@jest/globals";
import { encode, decode } from "../src/proto";
import { expectRoundTripEquality } from "./test-utils";

describe("Tool Call Events", () => {
  describe("ToolCallStartEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: ToolCallStartEvent = {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "tool-1",
        toolCallName: "get_weather",
      };

      expectRoundTripEquality(event);
    });

    it("should handle event with parent message id", () => {
      const event: ToolCallStartEvent = {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "search_database",
        parentMessageId: "msg-123",
      };

      expectRoundTripEquality(event);
    });

    it("should preserve all optional fields", () => {
      const event: ToolCallStartEvent = {
        type: EventType.TOOL_CALL_START,
        timestamp: 1698765432123,
        toolCallId: "tool-call-id-123",
        toolCallName: "very_long_tool_name_with_underscores",
        parentMessageId: "parent-message-id-456",
        rawEvent: { original: "event data", from: "source system" },
      };

      expectRoundTripEquality(event);
    });
  });

  describe("ToolCallArgsEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: ToolCallArgsEvent = {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "tool-1",
        delta: '{"location":"San Francisco"}',
      };

      expectRoundTripEquality(event);
    });

    it("should handle complex JSON in delta", () => {
      const complexJson = JSON.stringify({
        query: "SELECT * FROM users",
        filters: {
          age: { min: 18, max: 65 },
          status: ["active", "pending"],
          location: {
            country: "US",
            states: ["CA", "NY", "TX"],
          },
        },
        options: {
          limit: 100,
          offset: 0,
          sort: { field: "created_at", order: "desc" },
        },
      });

      const event: ToolCallArgsEvent = {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "db-query-tool-123",
        delta: complexJson,
      };

      expectRoundTripEquality(event);
    });

    it("should handle special characters in delta", () => {
      const event: ToolCallArgsEvent = {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-1",
        delta: '{"text":"Special chars: 🚀 ñ € 😊 \\n\\t\\"\'\\\\"}',
      };

      expectRoundTripEquality(event);
    });

    it("should handle partial JSON in delta (streaming case)", () => {
      // Test case for when JSON might be sent in chunks
      const event: ToolCallArgsEvent = {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "streaming-tool",
        delta: '{"location":"San Fran',
      };

      expectRoundTripEquality(event);
    });
  });

  describe("ToolCallEndEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "tool-1",
      };

      expectRoundTripEquality(event);
    });

    it("should handle minimal required fields", () => {
      const event: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-1",
      };

      expectRoundTripEquality(event);
    });
  });

  describe("Complex Tool Call Sequence", () => {
    it("should correctly encode/decode a sequence of related tool call events", () => {
      // Create a sequence of related tool call events
      const startEvent: ToolCallStartEvent = {
        type: EventType.TOOL_CALL_START,
        timestamp: 1000,
        toolCallId: "complex-tool-1",
        toolCallName: "query_database",
      };

      const argsEvent1: ToolCallArgsEvent = {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: 1001,
        toolCallId: "complex-tool-1",
        delta: '{"query":"SELECT * FROM',
      };

      const argsEvent2: ToolCallArgsEvent = {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: 1002,
        toolCallId: "complex-tool-1",
        delta: ' users WHERE age > 18"}',
      };

      const endEvent: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        timestamp: 1003,
        toolCallId: "complex-tool-1",
      };

      // Test each event in the sequence
      expectRoundTripEquality(startEvent);
      expectRoundTripEquality(argsEvent1);
      expectRoundTripEquality(argsEvent2);
      expectRoundTripEquality(endEvent);

      // Ensure toolCallId is preserved across events
      const decodedStart = decode(encode(startEvent)) as ToolCallStartEvent;
      const decodedArgs1 = decode(encode(argsEvent1)) as ToolCallArgsEvent;
      const decodedArgs2 = decode(encode(argsEvent2)) as ToolCallArgsEvent;
      const decodedEnd = decode(encode(endEvent)) as ToolCallEndEvent;

      // Check consistent fields across events
      expect(decodedStart.toolCallId).toBe(startEvent.toolCallId);

      expect(decodedArgs1.toolCallId).toBe(argsEvent1.toolCallId);

      expect(decodedArgs2.toolCallId).toBe(argsEvent2.toolCallId);

      expect(decodedEnd.toolCallId).toBe(endEvent.toolCallId);
    });
  });
});
