import { Subject } from "rxjs";
import { verifyEvents } from "../verify";
import {
  BaseEvent,
  EventType,
  AGUIError,
  RunStartedEvent,
  RunFinishedEvent,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  TextMessageStartEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";

describe("verifyEvents subagent lifecycle", () => {
  // Test: A well-formed subagent lifecycle within a run resolves
  it("should allow a well-formed subagent lifecycle within a run", async () => {
    const source$ = new Subject<BaseEvent>();

    const events: BaseEvent[] = [];
    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        fail(`Should not have errored: ${err.message}`);
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "sub-agent-1",
    } as SubagentStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_FINISHED,
      subagentId: "s1",
    } as SubagentFinishedEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunFinishedEvent);

    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));
    subscription.unsubscribe();

    expect(events.length).toBe(4);
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });

  // Test: Duplicate SUBAGENT_STARTED for the same id rejects
  it("should reject a duplicate SUBAGENT_STARTED for the same id", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toMatch(/already/i);
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "sub-agent-1",
    } as SubagentStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "sub-agent-1",
    } as SubagentStartedEvent);

    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.SUBAGENT_STARTED);
  });

  // Test: SUBAGENT_FINISHED for an id that never started rejects
  it("should reject SUBAGENT_FINISHED for an id that never started", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toMatch(/not started|no active|matching/i);
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_FINISHED,
      subagentId: "s1",
    } as SubagentFinishedEvent);

    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: SUBAGENT_STARTED whose parentSubagentId was not started rejects
  it("should reject SUBAGENT_STARTED whose parentSubagentId was not started", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toMatch(/parent/i);
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "sub-agent-1",
      parentSubagentId: "missing-parent",
    } as SubagentStartedEvent);

    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(1);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
  });

  // Test: RUN_FINISHED while a subagent is still open rejects
  it("should reject RUN_FINISHED while a subagent is still open", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        expect(err).toBeInstanceOf(AGUIError);
        expect(err.message).toMatch(/subagent/i);
        subscription.unsubscribe();
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "sub-agent-1",
    } as SubagentStartedEvent);

    // Intentionally not finishing s1
    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunFinishedEvent);

    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events.length).toBe(2);
    expect(events[1].type).toBe(EventType.SUBAGENT_STARTED);
  });

  // Test: A stream with no lifecycle events at all is still valid
  it("should allow a stream with no subagent lifecycle events", async () => {
    const source$ = new Subject<BaseEvent>();
    const events: BaseEvent[] = [];

    const subscription = verifyEvents(false)(source$).subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        fail(`Should not have errored: ${err.message}`);
      },
    });

    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunStartedEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
      subagentId: "s1",
    } as TextMessageStartEvent);

    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m1",
      subagentId: "s1",
    } as TextMessageEndEvent);

    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "test-thread-id",
      runId: "test-run-id",
    } as RunFinishedEvent);

    source$.complete();
    await new Promise((resolve) => setTimeout(resolve, 100));
    subscription.unsubscribe();

    expect(events.length).toBe(4);
    expect(events[3].type).toBe(EventType.RUN_FINISHED);
  });
});
