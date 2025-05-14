import {
  BaseEvent,
  EventType,
  MessagesSnapshotEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";
import { expect, describe, it } from "@jest/globals";
import { encode, decode } from "../src/proto";
import { expectRoundTripEquality } from "./test-utils";

describe("Message Events", () => {
  describe("TextMessageStartEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "msg-1",
        role: "assistant",
      };

      expectRoundTripEquality(event);
    });

    it("should handle missing optional fields", () => {
      const event: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
        role: "assistant",
      };

      expectRoundTripEquality(event);
    });
  });

  describe("TextMessageContentEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "msg-1",
        delta: "Hello, how can I help you today?",
      };

      expectRoundTripEquality(event);
    });

    it("should handle special characters in content delta", () => {
      const event: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Special chars: 🚀 ñ € 😊 \n\t\"'\\`",
      };

      expectRoundTripEquality(event);
    });
  });

  describe("TextMessageEndEvent", () => {
    it("should round-trip encode/decode correctly", () => {
      const event: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "msg-1",
      };

      expectRoundTripEquality(event);
    });
  });

  describe("MessagesSnapshotEvent", () => {
    it("should round-trip encode/decode with multiple messages", () => {
      const event: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: Date.now(),
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Can you help me with my task?",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "I'd be happy to help! What task do you need assistance with?",
          },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle messages with tool calls", () => {
      const event: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "What's the weather in San Francisco?",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Let me check the weather for you.",
            toolCalls: [
              {
                id: "tool-1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: JSON.stringify({ location: "San Francisco" }),
                },
              },
            ],
          },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle messages with multiple tool calls and complex arguments", () => {
      const event: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: undefined, // Changed from null to undefined
            toolCalls: [
              {
                id: "tool-1",
                type: "function",
                function: {
                  name: "analyze_data",
                  arguments: JSON.stringify({
                    dataset: "sales_2023",
                    metrics: ["revenue", "growth", "conversion"],
                    filters: {
                      region: "North America",
                      timeframe: { start: "2023-01-01", end: "2023-12-31" },
                    },
                  }),
                },
              },
              {
                id: "tool-2",
                type: "function",
                function: {
                  name: "generate_report",
                  arguments: JSON.stringify({
                    title: "Annual Sales Report",
                    format: "pdf",
                    sections: ["summary", "detailed_analysis", "recommendations"],
                  }),
                },
              },
            ],
          },
        ],
      };

      expectRoundTripEquality(event);
    });

    it("should handle messages with undefined toolCalls", () => {
      const event: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Hello",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Hi there!",
            // No toolCalls field
          },
        ],
      };

      const encoded = encode(event);
      const decoded = decode(encoded) as MessagesSnapshotEvent;

      // Check messages length
      expect(decoded.messages).toHaveLength(event.messages.length);

      // Check first message
      expect(decoded.messages[0].id).toBe(event.messages[0].id);
      expect(decoded.messages[0].role).toBe(event.messages[0].role);
      expect(decoded.messages[0].content).toBe(event.messages[0].content);
      expect((decoded.messages[0] as any).toolCalls).toBeUndefined();

      // Check second message
      expect(decoded.messages[1].id).toBe(event.messages[1].id);
      expect(decoded.messages[1].role).toBe(event.messages[1].role);
      expect(decoded.messages[1].content).toBe(event.messages[1].content);
      expect((decoded.messages[1] as any).toolCalls).toBeUndefined();
    });

    it("should handle messages with empty toolCalls array", () => {
      const event: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "I processed your request.",
            toolCalls: [], // Explicitly empty array
          },
        ],
      };

      const encoded = encode(event);
      const decoded = decode(encoded) as MessagesSnapshotEvent;

      // Check that empty toolCalls array is converted to undefined
      expect(decoded.messages[0].id).toBe(event.messages[0].id);
      expect(decoded.messages[0].role).toBe(event.messages[0].role);
      expect(decoded.messages[0].content).toBe(event.messages[0].content);
      expect((decoded.messages[0] as any).toolCalls).toBeUndefined();
    });

    // Test for mixed messages (one with empty toolCalls, one with non-empty)
    it("should correctly handle a mix of messages with empty and non-empty toolCalls", () => {
      const event: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "First message",
            toolCalls: [], // Empty array that should be converted to undefined
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Second message",
            toolCalls: [
              {
                id: "tool-1",
                type: "function",
                function: {
                  name: "test_function",
                  arguments: "{}",
                },
              },
            ],
          },
        ],
      };

      const encoded = encode(event);
      const decoded = decode(encoded) as MessagesSnapshotEvent;

      // Check first message (empty toolCalls should be undefined)
      expect((decoded.messages[0] as any).toolCalls).toBeUndefined();

      // Check second message (non-empty toolCalls should be preserved)
      expect((decoded.messages[1] as any).toolCalls).toBeDefined();
      expect((decoded.messages[1] as any).toolCalls?.length).toBe(1);
    });
  });
});
