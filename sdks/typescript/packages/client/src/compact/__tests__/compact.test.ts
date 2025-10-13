import { compactEvents } from "../compact";
import {
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  CustomEvent,
} from "@ag-ui/core";

describe("Event Compaction", () => {
  describe("Text Message Compaction", () => {
    it("should compact multiple text message content events into one", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: " " },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "world" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Hello world");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
    });

    it("should move interleaved events to after text message events", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Processing" },
        { type: EventType.CUSTOM, id: "custom1", name: "thinking" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "..." },
        { type: EventType.CUSTOM, id: "custom2", name: "done-thinking" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(5);
      // Text message events should come first
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Processing...");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
      // Other events should come after
      expect(compacted[3].type).toBe(EventType.CUSTOM);
      expect((compacted[3] as CustomEvent & { id: string }).id).toBe("custom1");
      expect(compacted[4].type).toBe(EventType.CUSTOM);
      expect((compacted[4] as CustomEvent & { id: string }).id).toBe("custom2");
    });

    it("should handle multiple messages independently", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hi" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg2", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg2", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg2", delta: " there" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg2" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // First message
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect((compacted[0] as TextMessageStartEvent).messageId).toBe("msg1");
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Hi");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
      // Second message
      expect(compacted[3].type).toBe(EventType.TEXT_MESSAGE_START);
      expect((compacted[3] as TextMessageStartEvent).messageId).toBe("msg2");
      expect(compacted[4].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[4] as TextMessageContentEvent).delta).toBe("Hello there");
      expect(compacted[5].type).toBe(EventType.TEXT_MESSAGE_END);
    });

    it("should handle incomplete messages", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Incomplete" },
        // No END event
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(2);
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Incomplete");
    });

    it("should pass through non-text-message events unchanged", () => {
      const events = [
        { type: EventType.CUSTOM, id: "custom1", name: "event1" },
        { type: EventType.TOOL_CALL_START, toolCallId: "tool1", toolCallName: "search" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toEqual(events);
    });

    it("should handle empty content deltas", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "user" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Hello" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Hello");
    });
  });

  describe("Tool Call Compaction", () => {
    it("should compact multiple tool call args events into one", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"query": "' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "weather" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: ' today"' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"query": "weather today"}');
      expect(compacted[2].type).toBe(EventType.TOOL_CALL_END);
    });

    it("should move interleaved events to after tool call events", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "calculate",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"a": ' },
        { type: EventType.CUSTOM, id: "custom1", name: "processing" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '10, "b": 20}' },
        { type: EventType.CUSTOM, id: "custom2", name: "calculating" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(5);
      // Tool call events should come first
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"a": 10, "b": 20}');
      expect(compacted[2].type).toBe(EventType.TOOL_CALL_END);
      // Other events should come after
      expect(compacted[3].type).toBe(EventType.CUSTOM);
      expect((compacted[3] as CustomEvent & { id: string }).id).toBe("custom1");
      expect(compacted[4].type).toBe(EventType.CUSTOM);
      expect((compacted[4] as CustomEvent & { id: string }).id).toBe("custom2");
    });

    it("should handle multiple tool calls independently", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"query": "test"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool2",
          toolCallName: "calculate",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool2", delta: '{"a": ' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool2", delta: "5}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool2" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // First tool call
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect((compacted[0] as ToolCallStartEvent).toolCallId).toBe("tool1");
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"query": "test"}');
      expect(compacted[2].type).toBe(EventType.TOOL_CALL_END);
      // Second tool call
      expect(compacted[3].type).toBe(EventType.TOOL_CALL_START);
      expect((compacted[3] as ToolCallStartEvent).toolCallId).toBe("tool2");
      expect(compacted[4].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[4] as ToolCallArgsEvent).delta).toBe('{"a": 5}');
      expect(compacted[5].type).toBe(EventType.TOOL_CALL_END);
    });

    it("should handle incomplete tool calls", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"incomplete": ' },
        // No END event
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(2);
      expect(compacted[0].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"incomplete": ');
    });

    it("should handle empty args deltas", () => {
      const events = [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"test": true}' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: "" },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(3);
      expect((compacted[1] as ToolCallArgsEvent).delta).toBe('{"test": true}');
    });
  });

  describe("Mixed Compaction", () => {
    it("should handle text messages and tool calls together", () => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "msg1", role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "Let me " },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg1", delta: "search for that" },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg1" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool1",
          toolCallName: "search",
          parentMessageId: "msg1",
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: '{"q": "' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool1", delta: 'test"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "tool1" },
      ];

      const compacted = compactEvents(events);

      expect(compacted).toHaveLength(6);
      // Text message
      expect(compacted[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(compacted[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((compacted[1] as TextMessageContentEvent).delta).toBe("Let me search for that");
      expect(compacted[2].type).toBe(EventType.TEXT_MESSAGE_END);
      // Tool call
      expect(compacted[3].type).toBe(EventType.TOOL_CALL_START);
      expect(compacted[4].type).toBe(EventType.TOOL_CALL_ARGS);
      expect((compacted[4] as ToolCallArgsEvent).delta).toBe('{"q": "test"}');
      expect(compacted[5].type).toBe(EventType.TOOL_CALL_END);
    });
  });
});
