import { Subject } from "rxjs";
import { toArray, catchError } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  AGUIError,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  StepStartedEvent,
  StepFinishedEvent,
  RawEvent,
  CustomEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
} from "@ag-ui/core";

describe("verifyEvents tool calls", () => {
  // Test: Cannot send lifecycle events inside a tool call
  it("should not allow lifecycle events inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'STEP_STARTED' after 'TOOL_CALL_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to send a lifecycle event inside the tool call
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "step1",
    } as StepStartedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Cannot send text message events inside a tool call
  it("should not allow text message events inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'TEXT_MESSAGE_START' after 'TOOL_CALL_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to send a text message event inside the tool call
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Cannot start a nested tool call
  it("should not allow nested tool calls", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send 'TOOL_CALL_START' event: A tool call is already in progress`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to start another tool call inside the first one
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t2",
      toolCallName: "test-tool-2",
    } as ToolCallStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Should allow TOOL_CALL_ARGS and TOOL_CALL_END inside a tool call
  it("should allow TOOL_CALL_ARGS and TOOL_CALL_END inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // Send a valid sequence with tool call events
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args 1",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args 2",
    } as ToolCallArgsEvent); // Multiple args allowed
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
    } as ToolCallEndEvent);
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.TOOL_CALL_START);
    expect(result[2].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[3].type).toBe(EventType.TOOL_CALL_ARGS);
    expect(result[4].type).toBe(EventType.TOOL_CALL_END);
  });

  // Test: Should allow RAW inside a tool call
  it("should allow RAW inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();

    // Set up subscription and collect events
    const promise = firstValueFrom(
      verifyEvents(source$).pipe(
        toArray(),
        catchError((err) => {
          throw err;
        }),
      ),
    );

    // Send a valid sequence with a raw event inside a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);
    source$.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "t1",
      delta: "test args",
    } as ToolCallArgsEvent);
    source$.next({
      type: EventType.RAW,
      event: {
        type: "raw_data",
        content: "test",
      },
    } as RawEvent);
    source$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "t1",
    } as ToolCallEndEvent);
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.RAW);
  });

  // Test: Should not allow CUSTOM inside a tool call
  it("should not allow CUSTOM inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(`Cannot send event type 'CUSTOM' after 'TOOL_CALL_START'`);
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to send a meta event inside the tool call
    source$.next({
      type: EventType.CUSTOM,
      name: "PredictState",
      value: [{ state_key: "test", tool: "test-tool" }],
    } as CustomEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Should not allow STATE_SNAPSHOT inside a tool call
  it("should not allow STATE_SNAPSHOT inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'STATE_SNAPSHOT' after 'TOOL_CALL_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to send a state snapshot inside the tool call
    source$.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { test: true },
    } as StateSnapshotEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Should not allow STATE_DELTA inside a tool call
  it("should not allow STATE_DELTA inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'STATE_DELTA' after 'TOOL_CALL_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to send a state delta inside the tool call
    source$.next({
      type: EventType.STATE_DELTA,
      delta: [{ op: "add", path: "/test", value: true }],
    } as StateDeltaEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });

  // Test: Should not allow MESSAGES_SNAPSHOT inside a tool call
  it("should not allow MESSAGES_SNAPSHOT inside a tool call", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'MESSAGES_SNAPSHOT' after 'TOOL_CALL_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a tool call
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Try to send a messages snapshot inside the tool call
    source$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ role: "user", content: "test" }],
    } as MessagesSnapshotEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TOOL_CALL_START);
  });
});
