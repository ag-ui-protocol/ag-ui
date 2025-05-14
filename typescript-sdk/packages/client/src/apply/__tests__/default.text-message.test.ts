import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  AgentState,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";

describe("defaultApplyEvents with text messages", () => {
  it("should handle text message events correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Hello ",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "world!",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 3 state updates:
    // 1. After TEXT_MESSAGE_START
    // 2. After first TEXT_MESSAGE_CONTENT
    // 3. After second TEXT_MESSAGE_CONTENT
    // And NO update after TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(3);

    // First update: empty message added
    expect(stateUpdates[0]?.messages?.length).toBe(1);
    expect(stateUpdates[0]?.messages?.[0]?.id).toBe("msg1");
    expect(stateUpdates[0]?.messages?.[0]?.content).toBe("");

    // Second update: first content chunk added
    expect(stateUpdates[1]?.messages?.length).toBe(1);
    expect(stateUpdates[1]?.messages?.[0]?.content).toBe("Hello ");

    // Third update: second content chunk appended
    expect(stateUpdates[2]?.messages?.length).toBe(1);
    expect(stateUpdates[2]?.messages?.[0]?.content).toBe("Hello world!");

    // Verify the last update came from TEXT_MESSAGE_CONTENT, not TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(3);
  });

  it("should handle multiple text messages correctly", async () => {
    // Create a subject and state for events
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // Create the observable stream
    const result$ = defaultApplyEvents(initialState, events$);

    // Collect all emitted state updates in an array
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Send events for two different messages
    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);

    // First message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "First message",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second message
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg2",
      role: "user",
    } as unknown as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg2",
      delta: "Second message",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg2",
    } as TextMessageEndEvent);

    // Add a small delay to ensure any potential updates would be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Complete the events stream
    events$.complete();

    // Wait for all state updates
    const stateUpdates = await stateUpdatesPromise;

    // We should have exactly 4 state updates:
    // 1. After first TEXT_MESSAGE_START
    // 2. After first TEXT_MESSAGE_CONTENT
    // 3. After second TEXT_MESSAGE_START
    // 4. After second TEXT_MESSAGE_CONTENT
    // And NO updates after either TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(4);

    // First update: first empty message added
    expect(stateUpdates[0]?.messages?.length).toBe(1);
    expect(stateUpdates[0]?.messages?.[0]?.id).toBe("msg1");
    expect(stateUpdates[0]?.messages?.[0]?.role).toBe("assistant");
    expect(stateUpdates[0]?.messages?.[0]?.content).toBe("");

    // Second update: first message content added
    expect(stateUpdates[1]?.messages?.length).toBe(1);
    expect(stateUpdates[1]?.messages?.[0]?.content).toBe("First message");

    // Third update: second empty message added
    expect(stateUpdates[2]?.messages?.length).toBe(2);
    expect(stateUpdates[2]?.messages?.[0]?.id).toBe("msg1");
    expect(stateUpdates[2]?.messages?.[0]?.content).toBe("First message");
    expect(stateUpdates[2]?.messages?.[1]?.id).toBe("msg2");
    expect(stateUpdates[2]?.messages?.[1]?.role).toBe("user");
    expect(stateUpdates[2]?.messages?.[1]?.content).toBe("");

    // Fourth update: second message content added
    expect(stateUpdates[3]?.messages?.length).toBe(2);
    expect(stateUpdates[3]?.messages?.[0]?.content).toBe("First message");
    expect(stateUpdates[3]?.messages?.[1]?.content).toBe("Second message");

    // Verify no additional updates after either TEXT_MESSAGE_END
    expect(stateUpdates.length).toBe(4);
  });
});
