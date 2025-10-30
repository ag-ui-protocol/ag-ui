import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  } as unknown as AbstractAgent);

describe("defaultApplyEvents with activity events", () => {
  it("creates and updates activity messages via snapshot and delta", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["search"] },
    } as ActivitySnapshotEvent);

    events$.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "activity-1",
      activityType: "PLAN",
      patch: [{ op: "replace", path: "/tasks/0", value: "✓ search" }],
    } as ActivityDeltaEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    expect(stateUpdates.length).toBe(2);

    const snapshotUpdate = stateUpdates[0];
    expect(snapshotUpdate?.messages?.[0]?.role).toBe("activity");
    expect(snapshotUpdate?.messages?.[0]?.activityType).toBe("PLAN");
    expect(snapshotUpdate?.messages?.[0]?.content).toEqual({ tasks: ["search"] });

    const deltaUpdate = stateUpdates[1];
    expect(deltaUpdate?.messages?.[0]?.content).toEqual({ tasks: ["✓ search"] });
  });

  it("appends operations via delta when snapshot starts with an empty array", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    const firstOperation = { id: "op-1", status: "PENDING" };
    const secondOperation = { id: "op-2", status: "COMPLETED" };

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-ops",
      activityType: "PLAN",
      content: { operations: [] },
    } as ActivitySnapshotEvent);

    events$.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "activity-ops",
      activityType: "PLAN",
      patch: [
        { op: "add", path: "/operations/-", value: firstOperation },
      ],
    } as ActivityDeltaEvent);

    events$.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "activity-ops",
      activityType: "PLAN",
      patch: [
        { op: "add", path: "/operations/-", value: secondOperation },
      ],
    } as ActivityDeltaEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    expect(stateUpdates.length).toBe(3);

    const snapshotUpdate = stateUpdates[0];
    expect(snapshotUpdate?.messages?.[0]?.content).toEqual({ operations: [] });

    const firstDeltaUpdate = stateUpdates[1];
    expect(firstDeltaUpdate?.messages?.[0]?.content?.operations).toEqual([
      firstOperation,
    ]);

    const secondDeltaUpdate = stateUpdates[2];
    expect(secondDeltaUpdate?.messages?.[0]?.content?.operations).toEqual([
      firstOperation,
      secondOperation,
    ]);
  });

  it("does not replace existing activity message when replace is false", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "activity-1",
          role: "activity",
          activityType: "PLAN",
          content: { tasks: ["initial"] },
        },
      ],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages as Message[]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["updated"] },
      replace: false,
    } as ActivitySnapshotEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    expect(stateUpdates.length).toBe(1);
    const update = stateUpdates[0];
    expect(update?.messages?.[0]?.content).toEqual({ tasks: ["initial"] });
  });

  it("adds activity message when replace is false and none exists", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages as Message[]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["first"] },
      replace: false,
    } as ActivitySnapshotEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    expect(stateUpdates.length).toBe(1);
    const update = stateUpdates[0];
    expect(update?.messages?.[0]?.content).toEqual({ tasks: ["first"] });
    expect(update?.messages?.[0]?.role).toBe("activity");
  });

  it("replaces existing activity message when replace is true", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "activity-1",
          role: "activity" as const,
          activityType: "PLAN",
          content: { tasks: ["initial"] },
        },
      ],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages as Message[]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["updated"] },
      replace: true,
    } as ActivitySnapshotEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    expect(stateUpdates.length).toBe(1);
    const update = stateUpdates[0];
    expect(update?.messages?.[0]?.content).toEqual({ tasks: ["updated"] });
  });

  it("replaces non-activity message when replace is true", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "activity-1",
          role: "user" as const,
          content: "placeholder",
        },
      ],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages as Message[]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["first"] },
      replace: true,
    } as ActivitySnapshotEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    expect(stateUpdates.length).toBe(1);
    const update = stateUpdates[0];
    expect(update?.messages?.[0]?.role).toBe("activity");
    expect(update?.messages?.[0]?.content).toEqual({ tasks: ["first"] });
  });

  it("does not alter non-activity message when replace is false", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [
        {
          id: "activity-1",
          role: "user" as const,
          content: "placeholder",
        },
      ],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages as Message[]);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["first"] },
      replace: false,
    } as ActivitySnapshotEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    expect(stateUpdates.length).toBe(1);
    const update = stateUpdates[0];
    expect(update?.messages?.[0]?.role).toBe("user");
    expect(update?.messages?.[0]?.content).toBe("placeholder");
  });

  it("maintains replace semantics across runs", async () => {
    const firstRunEvents$ = new Subject<BaseEvent>();
    const baseInput: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const baseAgent = createAgent(baseInput.messages);
    const firstResult$ = defaultApplyEvents(baseInput, firstRunEvents$, baseAgent, []);
    const firstUpdatesPromise = firstValueFrom(firstResult$.pipe(toArray()));

    firstRunEvents$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["initial"] },
      replace: true,
    } as ActivitySnapshotEvent);
    firstRunEvents$.complete();

    const firstUpdates = await firstUpdatesPromise;
    const nextMessages = firstUpdates[0]?.messages ?? [];

    const secondRunEvents$ = new Subject<BaseEvent>();
    const secondInput: RunAgentInput = {
      ...baseInput,
      messages: nextMessages,
    };

    const secondAgent = createAgent(secondInput.messages);
    const secondResult$ = defaultApplyEvents(
      secondInput,
      secondRunEvents$,
      secondAgent,
      [],
    );
    const secondUpdatesPromise = firstValueFrom(secondResult$.pipe(toArray()));

    secondRunEvents$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["updated"] },
      replace: false,
    } as ActivitySnapshotEvent);

    secondRunEvents$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["final"] },
      replace: true,
    } as ActivitySnapshotEvent);

    secondRunEvents$.complete();

    const secondUpdates = await secondUpdatesPromise;
    expect(secondUpdates.length).toBe(2);
    const afterReplaceFalse = secondUpdates[0];
    expect(afterReplaceFalse?.messages?.[0]?.content).toEqual({ tasks: ["initial"] });
    const afterReplaceTrue = secondUpdates[1];
    expect(afterReplaceTrue?.messages?.[0]?.content).toEqual({ tasks: ["final"] });
  });
});
