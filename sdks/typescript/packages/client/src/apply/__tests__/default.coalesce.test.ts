import { describe, expect, it } from "vitest";
import { Subject, from, lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import type { AbstractAgent } from "@/agent";
import type { AgentSubscriber } from "@/agent/subscriber";

const input: RunAgentInput = {
  threadId: "t",
  runId: "r",
  messages: [],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
};
const agent = () => ({ messages: [], state: {} }) as unknown as AbstractAgent;

const events: BaseEvent[] = [
  { type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hel" } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "lo" } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
  { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } } as BaseEvent,
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: "c1",
    toolCallName: "f",
    parentMessageId: "m1",
  } as BaseEvent,
  { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{}" } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: "c1" } as BaseEvent,
  {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "r1",
    toolCallId: "c1",
    content: "ok",
  } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
];

const final = (updates: { messages?: Message[]; state?: unknown }[]) => ({
  messages: updates.filter((u) => u.messages).at(-1)?.messages,
  state: updates.filter((u) => u.state !== undefined).at(-1)?.state,
});

describe("defaultApplyEvents coalesce", () => {
  it("emits one update for events that arrive together, with the same final state", async () => {
    const separate = await lastValueFrom(
      defaultApplyEvents(input, from(events), agent(), []).pipe(toArray()),
    );
    const coalesced = await lastValueFrom(
      defaultApplyEvents(input, from(events), agent(), [], undefined, { coalesce: true }).pipe(
        toArray(),
      ),
    );
    expect(separate.length).toBeGreaterThan(1);
    expect(coalesced).toHaveLength(1);
    expect(final(coalesced)).toEqual(final(separate));
    expect(coalesced[0].messages?.map((m) => m.id)).toEqual(["m1", "r1"]);
    expect(coalesced[0].state).toEqual({ step: 1 });
  });

  it("still runs every per-event subscriber hook, with the messages so far", async () => {
    const seen: string[] = [];
    const subscriber: AgentSubscriber = {
      onEvent: ({ event }) => {
        seen.push(event.type);
      },
      onTextMessageEndEvent: ({ messages }) => {
        seen.push(`end:${messages.find((m) => m.id === "m1")?.content}`);
      },
    };
    await lastValueFrom(
      defaultApplyEvents(input, from(events), agent(), [subscriber], undefined, {
        coalesce: true,
      }).pipe(toArray()),
    );
    expect(seen.filter((s) => !s.startsWith("end:"))).toEqual(events.map((e) => e.type));
    expect(seen).toContain("end:Hello");
  });

  it("emits what it applied before the source failed in the middle of a burst", async () => {
    const source = new Subject<BaseEvent>();
    // The stream fails while the fourth event of the burst is being applied
    // and the rest are still waiting.
    const failOnFourth: AgentSubscriber = {
      onEvent: ({ event }) => {
        if (event === events[3]) source.error(new Error("stream failed"));
      },
    };
    const updates: { messages?: Message[]; state?: unknown }[] = [];
    const error = new Promise<unknown>((resolve) =>
      defaultApplyEvents(input, source, agent(), [failOnFourth], undefined, {
        coalesce: true,
      }).subscribe({
        next: (update) => updates.push(update),
        error: resolve,
      }),
    );
    for (const event of events) source.next(event);

    expect(await error).toEqual(new Error("stream failed"));
    expect(updates).toHaveLength(1);
    expect(updates[0].messages?.map((m) => [m.id, m.content])).toEqual([["m1", "Hel"]]);
  });

  it("emits a burst's update when the source fails before it was passed on", async () => {
    // The update is passed on a few microtasks after the last event of the
    // burst is applied. Fail the source at each microtask in turn: the first
    // snapshot is applied before the second one starts, so it must not be lost.
    const first = { type: EventType.STATE_SNAPSHOT, snapshot: { step: 1 } } as BaseEvent;
    const second = { type: EventType.STATE_SNAPSHOT, snapshot: { step: 2 } } as BaseEvent;
    for (let ticks = 0; ticks < 20; ticks += 1) {
      const source = new Subject<BaseEvent>();
      const failAfter = (left: number): void =>
        queueMicrotask(() =>
          left === 0 ? source.error(new Error("stream failed")) : failAfter(left - 1),
        );
      const failDuringSecond: AgentSubscriber = {
        onStateSnapshotEvent: ({ event }) => {
          if (event === second) failAfter(ticks);
        },
      };
      const states: unknown[] = [];
      const error = new Promise<unknown>((resolve) =>
        defaultApplyEvents(input, source, agent(), [failDuringSecond], undefined, {
          coalesce: true,
        }).subscribe({
          next: (update) => {
            if (update.state !== undefined) states.push(update.state);
          },
          error: resolve,
        }),
      );
      source.next(first);
      source.next(second);

      expect(await error).toEqual(new Error("stream failed"));
      expect(states, `source failed after ${ticks} microtasks`).not.toHaveLength(0);
    }
  });

  it("emits only the error, as without coalesce, when an event that arrived alone fails", async () => {
    // The activity is added before `onNewMessage` runs, and the hook fails.
    const activity = {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "a1",
      activityType: "card",
      content: { step: 1 },
    } as BaseEvent;
    const failingHook: AgentSubscriber = {
      onNewMessage: () => {
        throw new Error("hook failed");
      },
    };
    const run = (coalesce: boolean) => {
      const updates: unknown[] = [];
      const error = new Promise<unknown>((resolve) =>
        defaultApplyEvents(input, from([activity]), agent(), [failingHook], undefined, {
          coalesce,
        }).subscribe({ next: (update) => updates.push(update), error: resolve }),
      );
      return error.then((error) => ({ updates, error }));
    };

    const separate = await run(false);
    const coalesced = await run(true);
    expect(coalesced.error).toEqual(new Error("hook failed"));
    expect(separate.updates).toEqual([]);
    expect(coalesced.updates).toEqual(separate.updates);
  });

  it("emits per event when events arrive one at a time", async () => {
    const source = new Subject<BaseEvent>();
    const updates: unknown[] = [];
    const done = new Promise<void>((resolve) =>
      defaultApplyEvents(input, source, agent(), [], undefined, { coalesce: true }).subscribe({
        next: (update) => updates.push(update),
        complete: resolve,
      }),
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    for (const event of events.slice(0, 4)) {
      source.next(event);
      await settle();
    }
    source.complete();
    await done;
    // TEXT_MESSAGE_START and both CONTENT events change messages.
    expect(updates).toHaveLength(3);
  });
});
