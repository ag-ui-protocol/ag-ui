import {
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  type ReasoningMessageContentEvent,
} from "@ag-ui/core";
import { firstValueFrom, from } from "rxjs";
import { toArray } from "rxjs/operators";
import { compactEvents } from "../compact";
import { defaultApplyEvents } from "../../apply/default";
import { verifyEvents } from "../../verify/verify";
import type { AbstractAgent } from "@/agent";

async function verify(events: BaseEvent[]) {
  return firstValueFrom(from(events).pipe(verifyEvents(false), toArray()));
}

/** The messages a consumer ends up with after applying `events` through the real reducer. */
async function applyToMessages(events: BaseEvent[]): Promise<Message[]> {
  const agent = { messages: [], state: {} } as unknown as AbstractAgent;
  const input: RunAgentInput = {
    messages: [],
    state: {},
    threadId: "t",
    runId: "r",
    tools: [],
    context: [],
  };
  const mutations = await firstValueFrom(
    defaultApplyEvents(input, from(events), agent, []).pipe(toArray()),
  );
  const last = [...mutations].reverse().find((mutation) => mutation.messages !== undefined);
  return (last?.messages ?? []) as Message[];
}

const reasoningMessage = (messageId: string, deltas: string[]): BaseEvent[] => [
  { type: EventType.REASONING_START, messageId: `${messageId}-block` },
  { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
  ...deltas.map((delta) => ({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta })),
  { type: EventType.REASONING_MESSAGE_END, messageId },
  { type: EventType.REASONING_END, messageId: `${messageId}-block` },
];

describe("reasoning message compaction", () => {
  it("collapses reasoning content deltas into one content event", () => {
    const compacted = compactEvents([
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "Let me " },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "think" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "." },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
    ] as BaseEvent[]);

    expect(compacted.map((event) => event.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
    ]);
    expect((compacted[1] as ReasoningMessageContentEvent).delta).toBe("Let me think.");
  });

  it("compacts a run of reasoning, a tool call and an answer into a verifiable stream with the same messages", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      ...reasoningMessage("think-1", ["I should ", "look this ", "up."]),
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "search",
        parentMessageId: "answer",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '{"q":' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: '"ag-ui"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "result-1",
        toolCallId: "call-1",
        content: "found it",
      },
      ...reasoningMessage("think-2", ["Now I ", "can answer."]),
      { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Here " },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "it is." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ] as BaseEvent[];

    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);

    expect(compacted.filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)).toEqual(
      [
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "think-1",
          delta: "I should look this up.",
        },
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "think-2",
          delta: "Now I can answer.",
        },
      ],
    );
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
    expect(await applyToMessages(compacted)).toEqual(await applyToMessages(events));
  });

  it("moves events that arrive mid-message after the reasoning message", () => {
    const compacted = compactEvents([
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "a" },
      { type: EventType.CUSTOM, name: "progress", value: 1 },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "b" },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
    ] as BaseEvent[]);

    expect(compacted.map((event) => event.type)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.CUSTOM,
    ]);
    expect((compacted[1] as ReasoningMessageContentEvent).delta).toBe("ab");
  });

  it.each([
    {
      label: "reasoning and an answer",
      outer: [
        { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "a" },
      ],
      outerEnd: { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
    },
    {
      label: "a tool call and an answer",
      outer: [
        { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "lookup" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{}" },
      ],
      outerEnd: { type: EventType.TOOL_CALL_END, toolCallId: "c1" },
    },
  ])("keeps step events in order when $label overlap and end in reverse", async ({ outer, outerEnd }) => {
    const events = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "run" },
      ...outer,
      { type: EventType.STEP_STARTED, stepName: "model" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "answer" },
      { type: EventType.STEP_FINISHED, stepName: "model" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
      outerEnd,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "run" },
    ] as BaseEvent[];

    const compacted = compactEvents(events);
    const steps = compacted
      .filter((event) => event.type === EventType.STEP_STARTED || event.type === EventType.STEP_FINISHED)
      .map((event) => event.type);

    expect(steps).toEqual([EventType.STEP_STARTED, EventType.STEP_FINISHED]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  it("folds content metadata into the collapsed event and leaves start and end metadata alone", async () => {
    const events = [
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r1",
        role: "reasoning",
        metadata: { phase: "start" },
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "a",
        metadata: { model: "one", step: 1 },
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "b",
        metadata: { step: 2 },
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1", metadata: { phase: "end" } },
    ] as BaseEvent[];

    const compacted = compactEvents(events);

    expect(compacted[0].metadata).toEqual({ phase: "start" });
    expect(compacted[1].metadata).toEqual({ model: "one", step: 2 });
    expect(compacted[2].metadata).toEqual({ phase: "end" });
    expect(await applyToMessages(compacted)).toEqual(await applyToMessages(events));
  });

  it("keeps an incomplete reasoning message before RUN_ERROR", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      { type: EventType.REASONING_START, messageId: "block" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "half " },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "a thought" },
      { type: EventType.RUN_ERROR, message: "aborted", code: "ABORTED" },
    ] as BaseEvent[];

    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);

    expect(compacted.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.RUN_ERROR,
    ]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  it("flushes incomplete text, reasoning and tool streams in the order they opened", () => {
    const compacted = compactEvents([
      { type: EventType.TOOL_CALL_START, toolCallId: "call-1", toolCallName: "search" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "x" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "y" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-1", delta: "{}" },
    ] as BaseEvent[]);

    expect(compacted.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  describe("replays to the same messages as the original stream", () => {
    const run = (events: BaseEvent[]): BaseEvent[] => [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
      ...events,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ];

    async function expectSameReplay(events: BaseEvent[]) {
      await expect(verify(events)).resolves.toHaveLength(events.length);
      const compacted = compactEvents(events);
      await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
      expect(await applyToMessages(compacted)).toEqual(await applyToMessages(events));
      return compacted;
    }

    it.each([
      {
        kind: "reasoning",
        start: { type: EventType.REASONING_MESSAGE_START, messageId: "m", role: "reasoning" },
        delta: (delta: string) => ({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: "m", delta }),
        end: { type: EventType.REASONING_MESSAGE_END, messageId: "m" },
        snapshot: { id: "m", role: "reasoning", content: "a" },
      },
      {
        kind: "text",
        start: { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
        delta: (delta: string) => ({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta }),
        end: { type: EventType.TEXT_MESSAGE_END, messageId: "m" },
        snapshot: { id: "m", role: "assistant", content: "a" },
      },
      {
        kind: "tool call",
        start: {
          type: EventType.TOOL_CALL_START,
          toolCallId: "c",
          toolCallName: "lookup",
          parentMessageId: "m",
        },
        delta: (delta: string) => ({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c", delta }),
        end: { type: EventType.TOOL_CALL_END, toolCallId: "c" },
        snapshot: {
          id: "m",
          role: "assistant",
          toolCalls: [{ id: "c", type: "function", function: { name: "lookup", arguments: "a" } }],
        },
      },
    ])("does not combine $kind deltas across a messages snapshot", async ({ start, delta, end, snapshot }) => {
      // The snapshot restates the deltas before it; the one after it still
      // applies. Combined into one delta ahead of the snapshot, "b" is lost.
      await expectSameReplay(
        run([
          start,
          delta("a"),
          { type: EventType.MESSAGES_SNAPSHOT, messages: [snapshot] },
          delta("b"),
          end,
        ] as BaseEvent[]),
      );
    });

    it("keeps reasoning ahead of an answer that starts later but finishes first", async () => {
      const compacted = await expectSameReplay(
        run([
          { type: EventType.REASONING_MESSAGE_START, messageId: "reason", role: "reasoning" },
          { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "a" },
          { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "answer" },
          { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
          { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "b" },
          { type: EventType.REASONING_MESSAGE_END, messageId: "reason" },
        ] as BaseEvent[]),
      );
      expect((await applyToMessages(compacted)).map((message) => message.id)).toEqual([
        "reason",
        "answer",
      ]);
    });

    it("keeps two answers in the order they started", async () => {
      await expectSameReplay(
        run([
          { type: EventType.TEXT_MESSAGE_START, messageId: "first", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "first", delta: "one" },
          { type: EventType.TEXT_MESSAGE_START, messageId: "second", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "second", delta: "two" },
          { type: EventType.TEXT_MESSAGE_END, messageId: "second" },
          { type: EventType.TEXT_MESSAGE_END, messageId: "first" },
        ] as BaseEvent[]),
      );
    });

    it("keeps an activity message between messages where it arrived", async () => {
      await expectSameReplay(
        run([
          { type: EventType.REASONING_MESSAGE_START, messageId: "reason", role: "reasoning" },
          { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "answer" },
          { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
          {
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId: "activity",
            activityType: "progress",
            content: { done: 1 },
          },
          { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reason", delta: "a" },
          { type: EventType.REASONING_MESSAGE_END, messageId: "reason" },
        ] as BaseEvent[]),
      );
    });
  });

  it("passes an end without a start through unchanged", () => {
    const events = [
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
    ] as BaseEvent[];

    expect(compactEvents(events)).toEqual(events);
  });
});
