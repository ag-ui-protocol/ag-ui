import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  AgentState,
  RunStartedEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";

describe("defaultApplyEvents with tool calls", () => {
  it("should handle a single tool call correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: AgentState = {
      messages: [],
      state: {},
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query": "',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: "test search",
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 4 state updates:
    // 1. After TOOL_CALL_START
    // 2-4. After each TOOL_CALL_ARGS
    // And NO update after TOOL_CALL_END
    expect(stateUpdates.length).toBe(4);

    // First update: tool call created
    expect(stateUpdates[0].messages.length).toBe(1);
    expect(stateUpdates[0].messages[0]?.toolCalls?.length).toBe(1);
    expect(stateUpdates[0].messages[0]?.toolCalls?.[0]?.id).toBe("tool1");
    expect(stateUpdates[0].messages[0]?.toolCalls?.[0]?.function?.name).toBe("search");
    expect(stateUpdates[0].messages[0]?.toolCalls?.[0]?.function?.arguments).toBe("");

    // Second update: first args chunk added
    expect(stateUpdates[1].messages[0]?.toolCalls?.[0]?.function?.arguments).toBe('{"query": "');

    // Third update: second args chunk appended
    expect(stateUpdates[2].messages[0]?.toolCalls?.[0]?.function?.arguments).toBe(
      '{"query": "test search',
    );

    // Fourth update: third args chunk appended
    expect(stateUpdates[3].messages[0]?.toolCalls?.[0]?.function?.arguments).toBe(
      '{"query": "test search"}',
    );
  });

  it("should handle multiple tool calls correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: AgentState = {
      messages: [],
      state: {},
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events for two different tool calls
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);

    // First tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Second tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 4 state updates:
    // 1. After first TOOL_CALL_START
    // 2. After first TOOL_CALL_ARGS
    // 3. After second TOOL_CALL_START
    // 4. After second TOOL_CALL_ARGS
    expect(stateUpdates.length).toBe(4);

    // Check last state update for the correct tool calls
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages.length).toBe(2);

    // First message should have first tool call
    expect(finalState.messages[0]?.toolCalls?.length).toBe(1);
    expect(finalState.messages[0]?.toolCalls?.[0]?.id).toBe("tool1");
    expect(finalState.messages[0]?.toolCalls?.[0]?.function?.name).toBe("search");
    expect(finalState.messages[0]?.toolCalls?.[0]?.function?.arguments).toBe('{"query":"test"}');

    // Second message should have second tool call
    expect(finalState.messages[1]?.toolCalls?.length).toBe(1);
    expect(finalState.messages[1]?.toolCalls?.[0]?.id).toBe("tool2");
    expect(finalState.messages[1]?.toolCalls?.[0]?.function?.name).toBe("calculate");
    expect(finalState.messages[1]?.toolCalls?.[0]?.function?.arguments).toBe(
      '{"expression":"1+1"}',
    );
  });

  it("should handle tool calls with parent message ID correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();

    // Create initial state with an existing message
    const parentMessageId = "existing_message";
    const initialState: AgentState = {
      messages: [
        {
          id: parentMessageId,
          role: "assistant",
          content: "I'll help you with that.",
          toolCalls: [],
        },
      ],
      state: {},
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
      parentMessageId: parentMessageId,
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 2 state updates
    expect(stateUpdates.length).toBe(2);

    // Check that the tool call was added to the existing message
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages.length).toBe(1);
    expect(finalState.messages[0].id).toBe(parentMessageId);
    expect(finalState.messages[0].content).toBe("I'll help you with that.");
    expect(finalState.messages[0]?.toolCalls?.length).toBe(1);
    expect(finalState.messages[0]?.toolCalls?.[0]?.id).toBe("tool1");
    expect(finalState.messages[0]?.toolCalls?.[0]?.function?.name).toBe("search");
    expect(finalState.messages[0]?.toolCalls?.[0]?.function?.arguments).toBe('{"query":"test"}');
  });

  it("should handle errors and partial updates correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: AgentState = {
      messages: [],
      state: {},
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events with errors in the tool args JSON
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query',
    } as ToolCallArgsEvent); // Incomplete JSON
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: ':"test"}',
    } as ToolCallArgsEvent); // Completes the JSON
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should still have updates despite the JSON syntax error
    expect(stateUpdates.length).toBe(3);

    // Check the final JSON (should be valid now)
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages[0]?.toolCalls?.[0]?.function?.arguments).toBe('{"query:"test"}');
  });

  it("should handle advanced scenarios with multiple tools and text messages", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: AgentState = {
      messages: [],
      state: {},
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events with a mix of tool calls and text messages
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);

    // First tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool1",
      toolCallName: "search",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool1",
      delta: '{"query":"test"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool1",
    } as ToolCallEndEvent);

    // Second tool call
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool2",
      toolCallName: "calculate",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool2",
      delta: '{"expression":"1+1"}',
    } as ToolCallArgsEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool2",
    } as ToolCallEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // Check for expected state updates
    expect(stateUpdates.length).toBe(4);

    // Check the final state for both tool calls
    const finalState = stateUpdates[stateUpdates.length - 1];
    expect(finalState.messages.length).toBe(2);

    // Verify first tool call
    expect(finalState.messages[0]?.toolCalls?.length).toBe(1);
    expect(finalState.messages[0]?.toolCalls?.[0]?.id).toBe("tool1");
    expect(finalState.messages[0]?.toolCalls?.[0]?.function?.name).toBe("search");

    // Verify second tool call
    expect(finalState.messages[1]?.toolCalls?.length).toBe(1);
    expect(finalState.messages[1]?.toolCalls?.[0]?.id).toBe("tool2");
    expect(finalState.messages[1]?.toolCalls?.[0]?.function?.name).toBe("calculate");
  });
});
