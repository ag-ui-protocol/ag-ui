import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { AgentSubscriber } from "@/agent/subscriber";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

const runStarted = { type: EventType.RUN_STARTED, threadId: "t", runId: "r" };
const toolCall = [
  { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "search" },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}" },
  { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
];

const cases: [string, keyof AgentSubscriber, object[]][] = [
  [
    "TEXT_MESSAGE_END",
    "onNewMessage",
    [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
    ],
  ],
  ["TOOL_CALL_END", "onNewToolCall", toolCall],
  [
    "TOOL_CALL_RESULT",
    "onNewMessage",
    [
      ...toolCall,
      { type: EventType.TOOL_CALL_RESULT, messageId: "res1", toolCallId: "tc1", content: "ok" },
    ],
  ],
  [
    "REASONING_MESSAGE_END",
    "onNewMessage",
    [
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "hmm" },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
    ],
  ],
];

describe("defaultApplyEvents awaits async subscriber hooks", () => {
  it.each(cases)("waits for %s's %s before moving on", async (_event, hook, events) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const subscriber = { [hook]: vi.fn(() => pending) } as AgentSubscriber;

    const input: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "t",
      runId: "r",
      tools: [],
      context: [],
    };
    const events$ = new Subject<BaseEvent>();
    let finished = false;
    const done = firstValueFrom(
      defaultApplyEvents(input, events$, createAgent(), [subscriber]).pipe(toArray()),
    ).then(() => (finished = true));

    for (const event of [runStarted, ...events]) events$.next(event as BaseEvent);
    events$.complete();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(subscriber[hook]).toHaveBeenCalled();
    expect(finished).toBe(false);

    release();
    await done;
    expect(finished).toBe(true);
  });
});
