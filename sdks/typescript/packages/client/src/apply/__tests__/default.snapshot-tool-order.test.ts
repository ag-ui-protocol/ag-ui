import { firstValueFrom, from, toArray } from "rxjs";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

// A tool result must sit directly after the assistant message that issued its
// call. Providers reject `assistant(tool_call) -> assistant(text) -> tool`, and
// the client sends its stored order back as the next run's input.

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

const createInput = (messages: Message[] = []): RunAgentInput => ({
  threadId: "thread",
  runId: "run",
  state: {},
  tools: [],
  context: [],
  messages,
});

async function finalMessages(events: BaseEvent[], initial: Message[] = []) {
  const updates = await firstValueFrom(
    defaultApplyEvents(createInput(initial), from(events), createAgent(initial), []).pipe(
      toArray(),
    ),
  );
  return updates.filter((update) => update.messages).at(-1)!.messages!;
}

const call = (id: string, ...callIds: string[]): Message => ({
  id,
  role: "assistant",
  toolCalls: callIds.map((callId) => ({
    id: callId,
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  })),
});
const result = (id: string, toolCallId: string): Message => ({
  id,
  role: "tool",
  toolCallId,
  content: `result of ${toolCallId}`,
});
const text = (id: string, role: "user" | "assistant" = "assistant"): Message => ({
  id,
  role,
  content: `${id} text`,
});

const ids = (messages: Message[]) => messages.map((message) => message.id);

describe("MESSAGES_SNAPSHOT keeps tool results next to their calls", () => {
  it("does not detach a streamed result when the snapshot re-ids it", async () => {
    // The result streams under one id and the snapshot carries it under another.
    const messages = await finalMessages([
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "u1", role: "user" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "u1", delta: "u1 text" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "u1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "lookup",
        parentMessageId: "a1",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "c1", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "c1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a2", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a2", delta: "a2 text" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a2" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "streamed-result",
        toolCallId: "c1",
        content: "result of c1",
      },
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          text("u1", "user"),
          call("a1", "c1"),
          result("snapshot-result", "c1"),
          text("a2"),
        ],
      },
      { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
    ] as BaseEvent[]);

    expect(ids(messages)).toEqual(["u1", "a1", "snapshot-result", "a2"]);
  });

  it("repairs a history that is already out of order", async () => {
    // A reload seeds the store from a previously corrupted history. The
    // snapshot's ids all match, so only reordering can repair it.
    const broken = [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")];
    const messages = await finalMessages(
      [
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
        { type: EventType.MESSAGES_SNAPSHOT, messages: broken },
        { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
      ] as BaseEvent[],
      broken,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a2"]);
  });

  it("keeps the order of parallel results and places each after its own call", async () => {
    const initial = [
      text("u1", "user"),
      call("a1", "c1", "c2"),
      result("t1", "c1"),
      text("a2"),
      call("a3", "c3"),
      text("a4"),
    ];
    const messages = await finalMessages(
      [
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [...initial, result("t2", "c2"), result("t3", "c3")],
        },
        { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
      ] as BaseEvent[],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "t2", "a2", "a3", "t3", "a4"]);
  });

  it("leaves a result whose call is not in the history where it is", async () => {
    const snapshot = [
      text("u1", "user"),
      result("orphan", "missing"),
      text("a1"),
      call("a2", "c2"),
    ];
    const messages = await finalMessages([
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
      { type: EventType.MESSAGES_SNAPSHOT, messages: snapshot },
      { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
    ] as BaseEvent[]);

    expect(ids(messages)).toEqual(["u1", "orphan", "a1", "a2"]);
  });

  it("leaves a correctly ordered snapshot unchanged", async () => {
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1", "c2"),
      result("t2", "c2"),
      result("t1", "c1"),
      text("a2"),
    ];
    const messages = await finalMessages([
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
      { type: EventType.MESSAGES_SNAPSHOT, messages: snapshot },
      { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
    ] as BaseEvent[]);

    expect(messages).toEqual(snapshot);
  });

  it("does not move a result past client-only activity that follows its call", async () => {
    const activity: Message = {
      id: "act",
      role: "activity",
      activityType: "progress",
      content: {},
    } as Message;
    const initial = [
      text("u1", "user"),
      call("a1", "c1"),
      activity,
      result("t1", "c1"),
      text("a2"),
    ];
    const messages = await finalMessages(
      [
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [text("u1", "user"), call("a1", "c1"), result("t1", "c1"), text("a2")],
        },
        { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
      ] as BaseEvent[],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "act", "t1", "a2"]);
  });
});
