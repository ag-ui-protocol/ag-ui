import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  BaseEvent,
  EventType,
  Message,
  MessagesSnapshotEvent,
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

describe("MESSAGES_SNAPSHOT preserves activity messages", () => {
  const createAgent = (messages: Message[] = []) =>
    ({
      messages: messages.map((message) => ({ ...message })),
      state: {},
    }) as unknown as import("@/agent").AbstractAgent;

  const makeInput = (messages: Message[]): RunAgentInput => ({
    messages,
    state: {},
    threadId: "thread-snap",
    runId: "run-snap",
    tools: [],
    context: [],
  });

  it("preserves activity message between conversation messages", async () => {
    const initial: Message[] = [
      { id: "m1", role: "user", content: "hello" },
      { id: "act-1", role: "activity", activityType: "PLAN", content: { tasks: ["a"] } },
      { id: "m2", role: "assistant", content: "hi" },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: "hi" },
      ],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;

    expect(updates.length).toBe(1);
    const msgs = updates[0]?.messages!;
    expect(msgs.length).toBe(3);
    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "m2"]);
    expect(msgs[1].role).toBe("activity");
  });

  it("keeps activity message ordering after its anchor", async () => {
    const initial: Message[] = [
      { id: "m1", role: "user", content: "q1" },
      { id: "act-1", role: "activity", activityType: "PLAN", content: { x: 1 } },
      { id: "m2", role: "assistant", content: "a1" },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "user", content: "q1" },
        { id: "m2", role: "assistant", content: "a1" },
      ],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;
    const msgs = updates[0]?.messages!;

    // Activity should be after m1 (its anchor), not appended at end
    expect(msgs[0].id).toBe("m1");
    expect(msgs[1].id).toBe("act-1");
    expect(msgs[2].id).toBe("m2");
  });

  it("preserves activity at start of messages (null anchor)", async () => {
    const initial: Message[] = [
      { id: "act-0", role: "activity", activityType: "PLAN", content: { step: 0 } },
      { id: "m1", role: "user", content: "hello" },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "m1", role: "user", content: "hello" }],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;
    const msgs = updates[0]?.messages!;

    expect(msgs.length).toBe(2);
    expect(msgs[0].id).toBe("act-0");
    expect(msgs[1].id).toBe("m1");
  });

  it("preserves multiple activities with different anchors", async () => {
    const initial: Message[] = [
      { id: "act-a", role: "activity", activityType: "PLAN", content: { a: 1 } },
      { id: "m1", role: "user", content: "q" },
      { id: "act-b", role: "activity", activityType: "PLAN", content: { b: 2 } },
      { id: "m2", role: "assistant", content: "a" },
      { id: "act-c", role: "activity", activityType: "PLAN", content: { c: 3 } },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "user", content: "q" },
        { id: "m2", role: "assistant", content: "a" },
      ],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;
    const msgs = updates[0]?.messages!;

    expect(msgs.map((m) => m.id)).toEqual(["act-a", "m1", "act-b", "m2", "act-c"]);
  });

  it("preserves activity position when its preceding message is removed", async () => {
    const initial: Message[] = [
      { id: "m1", role: "user", content: "q" },
      { id: "act-1", role: "activity", activityType: "PLAN", content: { x: 1 } },
      { id: "m2", role: "assistant", content: "a" },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Snapshot removes m1
    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "m2", role: "assistant", content: "a" }],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;
    const msgs = updates[0]?.messages!;

    expect(msgs.length).toBe(2);
    expect(msgs[0].id).toBe("act-1");
    expect(msgs[1].id).toBe("m2");
  });

  it("keeps activities in position when new messages are added by snapshot", async () => {
    const initial: Message[] = [
      { id: "m1", role: "user", content: "q" },
      { id: "act-1", role: "activity", activityType: "PLAN", content: { x: 1 } },
      { id: "m2", role: "assistant", content: "a" },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Snapshot adds a new message m3
    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "user", content: "q" },
        { id: "m2", role: "assistant", content: "a" },
        { id: "m3", role: "user", content: "q2" },
      ],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;
    const msgs = updates[0]?.messages!;

    expect(msgs.map((m) => m.id)).toEqual(["m1", "act-1", "m2", "m3"]);
  });

  it("preserves activity position when a message ID changes in snapshot", async () => {
    // Simulates the real-world scenario: streaming creates a tool message with ID "tool-stream",
    // but MESSAGES_SNAPSHOT has the same tool message with a different canonical ID "tool-canon".
    // The activity stays in its original position; the renamed message is appended as new.
    const initial: Message[] = [
      { id: "m1", role: "user", content: "create a dashboard" },
      { id: "asst-1", role: "assistant", content: "I'll create that for you" },
      { id: "tool-stream", role: "tool", content: '{"a2ui": true}' },
      { id: "act-1", role: "activity", activityType: "A2UI_SURFACE", content: { surface: "dashboard" } },
      { id: "asst-2", role: "assistant", content: "Here's your dashboard" },
    ] as Message[];

    const events$ = new Subject<BaseEvent>();
    const agent = createAgent(initial);
    const result$ = defaultApplyEvents(makeInput(initial), events$, agent, []);
    const updatesPromise = firstValueFrom(result$.pipe(toArray()));

    // Snapshot has the same tool message but with a different ID
    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "m1", role: "user", content: "create a dashboard" },
        { id: "asst-1", role: "assistant", content: "I'll create that for you" },
        { id: "tool-canon", role: "tool", content: '{"a2ui": true}' },
        { id: "asst-2", role: "assistant", content: "Here's your dashboard" },
      ],
    } as MessagesSnapshotEvent);

    events$.complete();
    const updates = await updatesPromise;
    const msgs = updates[0]?.messages!;

    // Activity stays in position; tool-stream removed, tool-canon appended as new
    expect(msgs.map((m) => m.id)).toEqual([
      "m1", "asst-1", "act-1", "asst-2", "tool-canon",
    ]);
  });

});
