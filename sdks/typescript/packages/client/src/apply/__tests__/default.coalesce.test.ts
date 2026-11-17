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
