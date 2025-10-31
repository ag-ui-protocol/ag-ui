import { convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  CustomEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";
import { LegacyRuntimeProtocolEvent } from "../types";

describe("convertToLegacyEvents - Concurrent Operations", () => {
  const defaultParams = {
    threadId: "test-thread",
    runId: "test-run",
    agentName: "test-agent",
  };

  it("should handle concurrent text messages correctly", async () => {
    const mockEvents: BaseEvent[] = [
      // Start two concurrent text messages
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "msg1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "msg2",
        role: "assistant",
      } as TextMessageStartEvent,

      // Send content for both messages
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "msg1",
        delta: "First message content",
      } as TextMessageContentEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "msg2",
        delta: "Second message content",
      } as TextMessageContentEvent,

      // End messages in reverse order
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "msg2",
      } as TextMessageEndEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "msg1",
      } as TextMessageEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(6);

    // Verify message starts
    expect(events[0].type).toBe("TextMessageStart");
    expect(events[1].type).toBe("TextMessageStart");
    if (events[0].type === "TextMessageStart" && events[1].type === "TextMessageStart") {
      expect(events[0].messageId).toBe("msg1");
      expect(events[1].messageId).toBe("msg2");
    }

    // Verify message content
    expect(events[2].type).toBe("TextMessageContent");
    expect(events[3].type).toBe("TextMessageContent");
    if (events[2].type === "TextMessageContent" && events[3].type === "TextMessageContent") {
      expect(events[2].messageId).toBe("msg1");
      expect(events[2].content).toBe("First message content");
      expect(events[3].messageId).toBe("msg2");
      expect(events[3].content).toBe("Second message content");
    }

    // Verify message ends (in reverse order)
    expect(events[4].type).toBe("TextMessageEnd");
    expect(events[5].type).toBe("TextMessageEnd");
    if (events[4].type === "TextMessageEnd" && events[5].type === "TextMessageEnd") {
      expect(events[4].messageId).toBe("msg2");
      expect(events[5].messageId).toBe("msg1");
    }
  });

  it("should handle concurrent tool calls correctly", async () => {
    const mockEvents: BaseEvent[] = [
      // Start two concurrent tool calls
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "tool1",
        toolCallName: "search",
        parentMessageId: "msg1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "tool2",
        toolCallName: "calculate",
        parentMessageId: "msg2",
      } as ToolCallStartEvent,

      // Send args for both tool calls
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "tool1",
        delta: '{"query":"test search"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "tool2",
        delta: '{"expression":"2+2"}',
      } as ToolCallArgsEvent,

      // End tool calls in reverse order
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "tool2",
      } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "tool1",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(6);

    // Verify tool call starts
    expect(events[0].type).toBe("ActionExecutionStart");
    expect(events[1].type).toBe("ActionExecutionStart");
    if (events[0].type === "ActionExecutionStart" && events[1].type === "ActionExecutionStart") {
      expect(events[0].actionExecutionId).toBe("tool1");
      expect(events[0].actionName).toBe("search");
      expect(events[0].parentMessageId).toBe("msg1");
      expect(events[1].actionExecutionId).toBe("tool2");
      expect(events[1].actionName).toBe("calculate");
      expect(events[1].parentMessageId).toBe("msg2");
    }

    // Verify tool call args
    expect(events[2].type).toBe("ActionExecutionArgs");
    expect(events[3].type).toBe("ActionExecutionArgs");
    if (events[2].type === "ActionExecutionArgs" && events[3].type === "ActionExecutionArgs") {
      expect(events[2].actionExecutionId).toBe("tool1");
      expect(events[2].args).toBe('{"query":"test search"}');
      expect(events[3].actionExecutionId).toBe("tool2");
      expect(events[3].args).toBe('{"expression":"2+2"}');
    }

    // Verify tool call ends (in reverse order)
    expect(events[4].type).toBe("ActionExecutionEnd");
    expect(events[5].type).toBe("ActionExecutionEnd");
    if (events[4].type === "ActionExecutionEnd" && events[5].type === "ActionExecutionEnd") {
      expect(events[4].actionExecutionId).toBe("tool2");
      expect(events[5].actionExecutionId).toBe("tool1");
    }
  });

  it("should handle mixed concurrent text messages and tool calls", async () => {
    const mockEvents: BaseEvent[] = [
      // Start a text message
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "thinking_msg",
        role: "assistant",
      } as TextMessageStartEvent,

      // Start a tool call while message is active
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "search_tool",
        toolCallName: "web_search",
        parentMessageId: "tool_msg",
      } as ToolCallStartEvent,

      // Add content to text message
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "thinking_msg",
        delta: "Let me search for that...",
      } as TextMessageContentEvent,

      // Add args to tool call
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "search_tool",
        delta: '{"query":"concurrent events"}',
      } as ToolCallArgsEvent,

      // Start another text message
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "status_msg",
        role: "assistant",
      } as TextMessageStartEvent,

      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "status_msg",
        delta: "Processing...",
      } as TextMessageContentEvent,

      // End everything
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "thinking_msg",
      } as TextMessageEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "search_tool",
      } as ToolCallEndEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "status_msg",
      } as TextMessageEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(9);

    // Check the sequence matches expected pattern
    const expectedTypes = [
      "TextMessageStart", // thinking_msg start
      "ActionExecutionStart", // search_tool start
      "TextMessageContent", // thinking_msg content
      "ActionExecutionArgs", // search_tool args
      "TextMessageStart", // status_msg start
      "TextMessageContent", // status_msg content
      "TextMessageEnd", // thinking_msg end
      "ActionExecutionEnd", // search_tool end
      "TextMessageEnd", // status_msg end
    ];

    for (let i = 0; i < expectedTypes.length; i++) {
      expect(events[i].type).toBe(expectedTypes[i]);
    }

    // Verify specific content
    const thinkingContent = events.find(
      (e) => e.type === "TextMessageContent" && (e as any).messageId === "thinking_msg",
    );
    expect(thinkingContent).toBeDefined();
    if (thinkingContent?.type === "TextMessageContent") {
      expect(thinkingContent.content).toBe("Let me search for that...");
    }

    const toolArgs = events.find(
      (e) => e.type === "ActionExecutionArgs" && (e as any).actionExecutionId === "search_tool",
    );
    expect(toolArgs).toBeDefined();
    if (toolArgs?.type === "ActionExecutionArgs") {
      expect(toolArgs.args).toBe('{"query":"concurrent events"}');
    }
  });

  it("should handle multiple tool calls on same parent message", async () => {
    const mockEvents: BaseEvent[] = [
      // Start multiple tool calls with same parent
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "search1",
        toolCallName: "search",
        parentMessageId: "agent_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "calc1",
        toolCallName: "calculate",
        parentMessageId: "agent_msg",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "format1",
        toolCallName: "format",
        parentMessageId: "agent_msg",
      } as ToolCallStartEvent,

      // Send args for all tool calls
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "search1",
        delta: '{"query":"test"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "calc1",
        delta: '{"expression":"2*3"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "format1",
        delta: '{"format":"json"}',
      } as ToolCallArgsEvent,

      // End all tool calls
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "search1",
      } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "calc1",
      } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "format1",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(9);

    // Verify all start events have same parent
    const startEvents = events.filter((e) => e.type === "ActionExecutionStart");
    expect(startEvents).toHaveLength(3);
    for (const event of startEvents) {
      if (event.type === "ActionExecutionStart") {
        expect(event.parentMessageId).toBe("agent_msg");
      }
    }

    // Verify args events match correct tool calls
    const argsEvents = events.filter((e) => e.type === "ActionExecutionArgs");
    expect(argsEvents).toHaveLength(3);

    const searchArgs = argsEvents.find((e) => (e as any).actionExecutionId === "search1");
    expect(searchArgs).toBeDefined();
    if (searchArgs?.type === "ActionExecutionArgs") {
      expect(searchArgs.args).toBe('{"query":"test"}');
    }

    const calcArgs = argsEvents.find((e) => (e as any).actionExecutionId === "calc1");
    expect(calcArgs).toBeDefined();
    if (calcArgs?.type === "ActionExecutionArgs") {
      expect(calcArgs.args).toBe('{"expression":"2*3"}');
    }

    const formatArgs = argsEvents.find((e) => (e as any).actionExecutionId === "format1");
    expect(formatArgs).toBeDefined();
    if (formatArgs?.type === "ActionExecutionArgs") {
      expect(formatArgs.args).toBe('{"format":"json"}');
    }
  });

  it("should handle high-frequency concurrent events", async () => {
    const mockEvents: BaseEvent[] = [];

    // Create many concurrent messages and tool calls
    const numMessages = 5;
    const numToolCalls = 5;

    // Start all messages
    for (let i = 0; i < numMessages; i++) {
      mockEvents.push({
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now() + i,
        messageId: `msg${i}`,
        role: "assistant",
      } as TextMessageStartEvent);
    }

    // Start all tool calls
    for (let i = 0; i < numToolCalls; i++) {
      mockEvents.push({
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now() + numMessages + i,
        toolCallId: `tool${i}`,
        toolCallName: `tool_${i}`,
        parentMessageId: `tool_msg${i}`,
      } as ToolCallStartEvent);
    }

    // Send content for all messages
    for (let i = 0; i < numMessages; i++) {
      mockEvents.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now() + numMessages + numToolCalls + i,
        messageId: `msg${i}`,
        delta: `Content for message ${i}`,
      } as TextMessageContentEvent);
    }

    // Send args for all tool calls
    for (let i = 0; i < numToolCalls; i++) {
      mockEvents.push({
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now() + numMessages * 2 + numToolCalls + i,
        toolCallId: `tool${i}`,
        delta: `{"param${i}":"value${i}"}`,
      } as ToolCallArgsEvent);
    }

    // End all in reverse order
    for (let i = numMessages - 1; i >= 0; i--) {
      mockEvents.push({
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now() + numMessages * 2 + numToolCalls * 2 + (numMessages - 1 - i),
        messageId: `msg${i}`,
      } as TextMessageEndEvent);
    }

    for (let i = numToolCalls - 1; i >= 0; i--) {
      mockEvents.push({
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now() + numMessages * 3 + numToolCalls * 2 + (numToolCalls - 1 - i),
        toolCallId: `tool${i}`,
      } as ToolCallEndEvent);
    }

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    // Should have: numMessages starts + numToolCalls starts + numMessages content + numToolCalls args + numMessages ends + numToolCalls ends
    const expectedLength = numMessages * 3 + numToolCalls * 3;
    expect(events).toHaveLength(expectedLength);

    // Verify all message starts are present
    const messageStarts = events.filter((e) => e.type === "TextMessageStart");
    expect(messageStarts).toHaveLength(numMessages);
    for (let i = 0; i < numMessages; i++) {
      const start = messageStarts.find((e) => (e as any).messageId === `msg${i}`);
      expect(start).toBeDefined();
    }

    // Verify all tool call starts are present
    const toolStarts = events.filter((e) => e.type === "ActionExecutionStart");
    expect(toolStarts).toHaveLength(numToolCalls);
    for (let i = 0; i < numToolCalls; i++) {
      const start = toolStarts.find((e) => (e as any).actionExecutionId === `tool${i}`);
      expect(start).toBeDefined();
      if (start?.type === "ActionExecutionStart") {
        expect(start.actionName).toBe(`tool_${i}`);
      }
    }

    // Verify all message content is present
    const messageContent = events.filter((e) => e.type === "TextMessageContent");
    expect(messageContent).toHaveLength(numMessages);
    for (let i = 0; i < numMessages; i++) {
      const content = messageContent.find((e) => (e as any).messageId === `msg${i}`);
      expect(content).toBeDefined();
      if (content?.type === "TextMessageContent") {
        expect(content.content).toBe(`Content for message ${i}`);
      }
    }

    // Verify all tool call args are present
    const toolArgs = events.filter((e) => e.type === "ActionExecutionArgs");
    expect(toolArgs).toHaveLength(numToolCalls);
    for (let i = 0; i < numToolCalls; i++) {
      const args = toolArgs.find((e) => (e as any).actionExecutionId === `tool${i}`);
      expect(args).toBeDefined();
      if (args?.type === "ActionExecutionArgs") {
        expect(args.args).toBe(`{"param${i}":"value${i}"}`);
      }
    }
  });

  it("should handle interleaved content and args updates correctly", async () => {
    const mockEvents: BaseEvent[] = [
      // Start concurrent message and tool call
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "msg1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "tool1",
        toolCallName: "search",
        parentMessageId: "tool_msg1",
      } as ToolCallStartEvent,

      // Interleave content and args updates
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "msg1",
        delta: "Searching ",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "tool1",
        delta: '{"que',
      } as ToolCallArgsEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "msg1",
        delta: "for ",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "tool1",
        delta: 'ry":"',
      } as ToolCallArgsEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "msg1",
        delta: "information...",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "tool1",
        delta: 'test"}',
      } as ToolCallArgsEvent,

      // End both
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "msg1",
      } as TextMessageEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "tool1",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(10);

    // Verify the interleaved pattern
    expect(events[0].type).toBe("TextMessageStart");
    expect(events[1].type).toBe("ActionExecutionStart");
    expect(events[2].type).toBe("TextMessageContent");
    expect(events[3].type).toBe("ActionExecutionArgs");
    expect(events[4].type).toBe("TextMessageContent");
    expect(events[5].type).toBe("ActionExecutionArgs");
    expect(events[6].type).toBe("TextMessageContent");
    expect(events[7].type).toBe("ActionExecutionArgs");
    expect(events[8].type).toBe("TextMessageEnd");
    expect(events[9].type).toBe("ActionExecutionEnd");

    // Verify content chunks
    const contentEvents = events.filter((e) => e.type === "TextMessageContent");
    expect(contentEvents).toHaveLength(3);
    if (contentEvents[0]?.type === "TextMessageContent") {
      expect(contentEvents[0].content).toBe("Searching ");
    }
    if (contentEvents[1]?.type === "TextMessageContent") {
      expect(contentEvents[1].content).toBe("for ");
    }
    if (contentEvents[2]?.type === "TextMessageContent") {
      expect(contentEvents[2].content).toBe("information...");
    }

    // Verify args chunks
    const argsEvents = events.filter((e) => e.type === "ActionExecutionArgs");
    expect(argsEvents).toHaveLength(3);
    if (argsEvents[0]?.type === "ActionExecutionArgs") {
      expect(argsEvents[0].args).toBe('{"que');
    }
    if (argsEvents[1]?.type === "ActionExecutionArgs") {
      expect(argsEvents[1].args).toBe('ry":"');
    }
    if (argsEvents[2]?.type === "ActionExecutionArgs") {
      expect(argsEvents[2].args).toBe('test"}');
    }
  });

  it("should handle concurrent operations with predictive state updates", async () => {
    const mockEvents: BaseEvent[] = [
      // Set up predictive state
      {
        type: EventType.CUSTOM,
        timestamp: Date.now(),
        name: "PredictState",
        value: [
          {
            state_key: "search_results",
            tool: "search",
            tool_argument: "query",
          },
          {
            state_key: "calculation",
            tool: "calculate",
            tool_argument: "expression",
          },
        ],
      } as CustomEvent,

      // Start concurrent tool calls
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "search1",
        toolCallName: "search",
        parentMessageId: "msg1",
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "calc1",
        toolCallName: "calculate",
        parentMessageId: "msg2",
      } as ToolCallStartEvent,

      // Send args that should trigger state updates
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "search1",
        delta: '{"query":"concurrent test"}',
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "calc1",
        delta: '{"expression":"5*5"}',
      } as ToolCallArgsEvent,

      // End tool calls
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "search1",
      } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "calc1",
      } as ToolCallEndEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    // Should have: PredictState + 2 starts + 2 args + 2 state updates + 2 ends = 9 events
    expect(events).toHaveLength(9);

    // First event should be the meta event
    expect(events[0].type).toBe("MetaEvent");

    // Should have state update events triggered by the tool call args
    const stateEvents = events.filter((e) => e.type === "AgentStateMessage");
    expect(stateEvents).toHaveLength(2);

    // Verify first state update (from search)
    if (stateEvents[0]?.type === "AgentStateMessage") {
      const state = JSON.parse(stateEvents[0].state);
      expect(state.search_results).toBe("concurrent test");
    }

    // Verify second state update (from calculation)
    if (stateEvents[1]?.type === "AgentStateMessage") {
      const state = JSON.parse(stateEvents[1].state);
      expect(state.calculation).toBe("5*5");
    }
  });

  it("should handle concurrent operations with lifecycle steps", async () => {
    const mockEvents: BaseEvent[] = [
      // Start a step
      {
        type: EventType.STEP_STARTED,
        timestamp: Date.now(),
        stepName: "processing",
      } as StepStartedEvent,

      // Start concurrent operations during the step
      {
        type: EventType.TEXT_MESSAGE_START,
        timestamp: Date.now(),
        messageId: "thinking_msg",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TOOL_CALL_START,
        timestamp: Date.now(),
        toolCallId: "search_tool",
        toolCallName: "search",
        parentMessageId: "tool_msg",
      } as ToolCallStartEvent,

      // Add content and args
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        timestamp: Date.now(),
        messageId: "thinking_msg",
        delta: "Analyzing...",
      } as TextMessageContentEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        timestamp: Date.now(),
        toolCallId: "search_tool",
        delta: '{"query":"analysis"}',
      } as ToolCallArgsEvent,

      // End operations
      {
        type: EventType.TEXT_MESSAGE_END,
        timestamp: Date.now(),
        messageId: "thinking_msg",
      } as TextMessageEndEvent,
      {
        type: EventType.TOOL_CALL_END,
        timestamp: Date.now(),
        toolCallId: "search_tool",
      } as ToolCallEndEvent,

      // End the step
      {
        type: EventType.STEP_FINISHED,
        timestamp: Date.now(),
        stepName: "processing",
      } as StepFinishedEvent,
    ];

    const events = (await convertToLegacyEvents(
      defaultParams.threadId,
      defaultParams.runId,
      defaultParams.agentName,
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events).toHaveLength(8);

    // Verify the sequence includes step lifecycle and concurrent operations
    expect(events[0].type).toBe("AgentStateMessage"); // Step start
    expect(events[1].type).toBe("TextMessageStart");
    expect(events[2].type).toBe("ActionExecutionStart");
    expect(events[3].type).toBe("TextMessageContent");
    expect(events[4].type).toBe("ActionExecutionArgs");
    expect(events[5].type).toBe("TextMessageEnd");
    expect(events[6].type).toBe("ActionExecutionEnd");
    expect(events[7].type).toBe("AgentStateMessage"); // Step end

    // Verify step states
    const stepStates = events.filter((e) => e.type === "AgentStateMessage");
    expect(stepStates).toHaveLength(2);
    if (stepStates[0]?.type === "AgentStateMessage") {
      expect(stepStates[0].active).toBe(true);
    }
    if (stepStates[1]?.type === "AgentStateMessage") {
      expect(stepStates[1].active).toBe(false);
    }
  });
});
