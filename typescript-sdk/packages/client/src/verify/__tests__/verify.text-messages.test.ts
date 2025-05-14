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

describe("verifyEvents text messages", () => {
  // Test: Cannot send lifecycle events inside a text message
  it("should not allow lifecycle events inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'STEP_STARTED' after 'TEXT_MESSAGE_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send a lifecycle event inside the text message
    source$.next({
      type: EventType.STEP_STARTED,
      stepName: "step1",
    } as StepStartedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Cannot send tool-related events inside a text message
  it("should not allow tool-related events inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'TOOL_CALL_START' after 'TEXT_MESSAGE_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send a tool-related event inside the text message
    source$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "t1",
      toolCallName: "test-tool",
    } as ToolCallStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Should allow TEXT_MESSAGE_CONTENT inside a text message
  it("should allow TEXT_MESSAGE_CONTENT inside a text message", async () => {
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

    // Send a valid sequence with text message content
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 2",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(6);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[4].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  // Test: Should allow RAW inside a text message
  it("should allow RAW inside a text message", async () => {
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

    // Send a valid sequence with a raw event inside a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "test content",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.RAW,
      event: {
        type: "raw_data",
        content: "test",
      },
    } as RawEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(6);
    expect(result[3].type).toBe(EventType.RAW);
  });

  // Test: Should not allow CUSTOM inside a text message
  it("should not allow CUSTOM inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(`Cannot send event type 'CUSTOM' after 'TEXT_MESSAGE_START'`);
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send a meta event inside the text message
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
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Should not allow STATE_SNAPSHOT inside a text message
  it("should not allow STATE_SNAPSHOT inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'STATE_SNAPSHOT' after 'TEXT_MESSAGE_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send a state snapshot inside the text message
    source$.next({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { test: true },
    } as StateSnapshotEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Should not allow STATE_DELTA inside a text message
  it("should not allow STATE_DELTA inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'STATE_DELTA' after 'TEXT_MESSAGE_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send a state delta inside the text message
    source$.next({
      type: EventType.STATE_DELTA,
      delta: [{ op: "add", path: "/test", value: true }],
    } as StateDeltaEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Should not allow MESSAGES_SNAPSHOT inside a text message
  it("should not allow MESSAGES_SNAPSHOT inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'MESSAGES_SNAPSHOT' after 'TEXT_MESSAGE_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send a messages snapshot inside the text message
    source$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ role: "user", content: "test" }],
    } as MessagesSnapshotEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // Test: Cannot send RUN_FINISHED inside a text message
  it("should not allow RUN_FINISHED inside a text message", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          `Cannot send event type 'RUN_FINISHED' after 'TEXT_MESSAGE_START'`,
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send RUN_FINISHED inside the text message
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // NEW TEST: Missing TEXT_MESSAGE_END
  it("should not allow RUN_FINISHED when a text message hasn't been closed", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send event type 'RUN_FINISHED' after 'TEXT_MESSAGE_START': Send 'TEXT_MESSAGE_END' first.",
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);

    // Try to end the run without closing the text message
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(3);
    expect(events[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
  });

  // NEW TEST: Nesting text messages
  it("should not allow nested text messages", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send event type 'TEXT_MESSAGE_START' after 'TEXT_MESSAGE_START': Send 'TEXT_MESSAGE_END' first.",
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to start a nested text message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "2",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // NEW TEST: Mismatched message IDs
  it("should not allow text message content with mismatched IDs", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send 'TEXT_MESSAGE_CONTENT' event: Message ID mismatch. The ID '2' doesn't match the active message ID '1'.",
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message with ID "1"
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Try to send content with a different ID
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "2",
      delta: "content 2",
    } as TextMessageContentEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // NEW TEST: TEXT_MESSAGE_CONTENT before START
  it("should not allow text message content without a prior start event", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found. Start a text message with 'TEXT_MESSAGE_START' first.",
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run but skip starting a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to send content without starting a message
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // NEW TEST: TEXT_MESSAGE_END before START
  it("should not allow ending a text message that was never started", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain(
          "Cannot send 'TEXT_MESSAGE_END' event: No active text message found. A 'TEXT_MESSAGE_START' event must be sent first.",
        );
        subscription.unsubscribe();
      },
    });

    // Start a valid run but skip starting a text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to end a message that was never started
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // NEW TEST: Starting text message outside of a run
  it("should not allow starting a text message before RUN_STARTED", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("First event must be 'RUN_STARTED'");
        subscription.unsubscribe();
      },
    });

    // Try to start a text message before RUN_STARTED
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no events were processed
    expect(events.length).toBe(0);
  });

  // NEW TEST: Mismatched IDs for TEXT_MESSAGE_END
  it("should not allow text message end with mismatched ID", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("Cannot send 'TEXT_MESSAGE_END' event: Message ID mismatch");
        subscription.unsubscribe();
      },
    });

    // Start a valid run and open a text message with ID "1"
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);

    // Try to end with a different ID
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "2",
    } as TextMessageEndEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify only events before the error were processed
    expect(events.length).toBe(3);
    expect(events[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
  });

  // NEW TEST: Empty text messages (no content)
  it("should allow empty text messages with no content", async () => {
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

    // Send a valid sequence with an empty text message
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(4);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  // NEW TEST: Missing/undefined IDs for TEXT_MESSAGE_START
  it("should not allow text messages with undefined or null IDs", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    // Create a subscription that will complete only after an error
    const subscription = verifyEvents(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toContain("requires a valid message ID");
        subscription.unsubscribe();
      },
    });

    // Start a valid run
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // Try to start a text message with undefined ID
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "undefined-id",
      role: "assistant",
    } as TextMessageStartEvent);

    // Complete the source and wait a bit for processing
    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify events processed before the error
    expect(events.length).toBe(2);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_START);
  });

  // NEW TEST: Sequential text messages
  it("should allow multiple sequential text messages", async () => {
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

    // Send a valid sequence with multiple text messages
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    // First text message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);

    // Second text message
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "2",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "2",
      delta: "content 2",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "2",
    } as TextMessageEndEvent);

    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(8);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(result[4].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[5].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(result[6].type).toBe(EventType.TEXT_MESSAGE_END);
  });

  // NEW TEST: Text message at run boundaries
  it("should allow text messages immediately after RUN_STARTED and before RUN_FINISHED", async () => {
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

    // Send text message immediately after run start and before run end
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "1",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "1",
      delta: "content 1",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "1",
    } as TextMessageEndEvent);
    source$.next({ type: EventType.RUN_FINISHED } as RunFinishedEvent);

    // Complete the source
    source$.complete();

    // Await the promise and expect no errors
    const result = await promise;

    // Verify all events were processed
    expect(result.length).toBe(5);
    expect(result[0].type).toBe(EventType.RUN_STARTED);
    expect(result[1].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(result[3].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(result[4].type).toBe(EventType.RUN_FINISHED);
  });
});
