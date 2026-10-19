import { firstValueFrom, from, toArray } from "rxjs";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents, keepToolResultsWithCalls } from "../default";
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

const reasoning = (id: string): Message => ({ id, role: "reasoning", content: `${id} thought` });
const activity = (id: string): Message =>
  ({ id, role: "activity", activityType: "progress", content: {} }) as Message;

const ids = (messages: Message[]) => messages.map((message) => message.id);

// Runs one snapshot through the reducer, starting from `initial`.
const afterSnapshot = (snapshot: Message[], initial: Message[] = []) =>
  finalMessages(
    [
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
      { type: EventType.MESSAGES_SNAPSHOT, messages: snapshot },
      { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
    ] as BaseEvent[],
    initial,
  );

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

  it("leaves results alone when providers reuse a tool call id every turn", async () => {
    // Some providers emit `call_0` for the first call of every turn. Each
    // result answers the call right before it, not the first call with its id.
    const snapshot = [
      text("u1", "user"),
      call("a1", "call_0"),
      result("t1", "call_0"),
      text("a2"),
      text("u2", "user"),
      call("a3", "call_0"),
      result("t3", "call_0"),
      text("a4"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual([
      "u1",
      "a1",
      "t1",
      "a2",
      "u2",
      "a3",
      "t3",
      "a4",
    ]);
  });

  it("moves a drifted result with a reused id to the nearest call that issued it", async () => {
    const snapshot = [
      text("u1", "user"),
      call("a1", "call_0"),
      result("t1", "call_0"),
      text("a2"),
      text("u2", "user"),
      call("a3", "call_0"),
      text("a4"),
      result("t3", "call_0"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual([
      "u1",
      "a1",
      "t1",
      "a2",
      "u2",
      "a3",
      "t3",
      "a4",
    ]);
  });

  it("moves a drifted result with a reused id past a call that is already answered", async () => {
    // The later call already has its result, so the drifted one belongs to
    // the earlier, unanswered call.
    const snapshot = [
      text("u1", "user"),
      call("a1", "call_0"),
      text("a2"),
      call("a3", "call_0"),
      result("t3", "call_0"),
      text("a4"),
      result("t1", "call_0"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "a2", "a3", "t3", "a4"]);
  });

  it("emits a moved result once when the merge aliases its call twice", async () => {
    // Two local messages share the id "a1", so the merge maps both to the same
    // snapshot object, and the re-id'd result is appended after the text.
    const initial = [text("u1", "user"), call("a1", "c1"), call("a1", "c1"), text("a2")];
    const messages = await afterSnapshot(
      [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a1", "a2"]);
  });

  it("emits a moved result once when the merge aliases the result twice", async () => {
    // Two local results share the id "t1" and both map to the snapshot's copy.
    const initial = [
      text("u1", "user"),
      call("a1", "c1"),
      text("a2"),
      result("t1", "c1"),
      result("t1", "c1"),
    ];
    const messages = await afterSnapshot(
      [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a2"]);
  });

  it("tolerates null and non-object entries in toolCalls on unverified input", async () => {
    const malformed = [
      text("u1", "user"),
      { id: "a1", role: "assistant", toolCalls: [null] },
      { id: "a2", role: "assistant", toolCalls: [42, "c9", { type: "function" }] },
      call("a3", "c3"),
      text("a4"),
      result("t3", "c3"),
    ] as unknown as Message[];

    expect(ids(await afterSnapshot(malformed))).toEqual(["u1", "a1", "a2", "a3", "t3", "a4"]);
  });

  it("tolerates a non-array toolCalls on unverified input", async () => {
    // An object is not iterable, and its `id` must not register as a call.
    const malformed = [
      text("u1", "user"),
      { id: "a1", role: "assistant", toolCalls: { id: "c1" } },
      text("a2"),
      result("t1", "c1"),
    ] as unknown as Message[];

    expect(ids(await afterSnapshot(malformed))).toEqual(["u1", "a1", "a2", "t1"]);
  });

  it("does not pair a result without a toolCallId with a call without an id", async () => {
    const snapshot = [
      text("u1", "user"),
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      text("a2"),
      { id: "t1", role: "tool", content: "no call id" },
    ] as unknown as Message[];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "a2", "t1"]);
  });

  it("moves a result before reasoning that separates it from its call", async () => {
    // Reasoning is sent back to the backend, so it breaks the pairing.
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1"),
      reasoning("r1"),
      result("t1", "c1"),
      text("a2"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "r1", "a2"]);
  });

  it("moves a result before a user message that separates it from its call", async () => {
    const snapshot = [text("u1", "user"), call("a1", "c1"), text("u2", "user"), result("t1", "c1")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "u2"]);
  });

  it("leaves a result that sits before its call where it is", async () => {
    // Nothing earlier issued c1, so the result is not moved forward onto a
    // later call it may not answer.
    const snapshot = [text("u1", "user"), result("t1", "c1"), call("a1", "c1"), text("a2")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "t1", "a1", "a2"]);
  });

  it("leaves a result before its call alone when that call ends the list", async () => {
    const snapshot = [text("u1", "user"), result("t1", "c1"), call("a1", "c1")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "t1", "a1"]);
  });

  it("keeps several results for one call together after it", async () => {
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1"),
      result("t1", "c1"),
      text("a2"),
      result("t1b", "c1"),
      result("t1c", "c1"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "t1b", "t1c", "a2"]);
  });

  it("places parallel results split across two assistant messages after their own call", async () => {
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1"),
      call("a2", "c2"),
      result("t1", "c1"),
      result("t2", "c2"),
      text("a3"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "a2", "t2", "a3"]);
  });

  it("leaves a result alone when its call is the last non-tool message", async () => {
    const snapshot = [text("u1", "user"), call("a1", "c1"), activity("act"), result("t1", "c1")];

    expect(ids(await afterSnapshot(snapshot, snapshot))).toEqual(["u1", "a1", "act", "t1"]);
  });

  it("lands a moved result after client-only activity that follows its call", async () => {
    // Activity is never sent to the backend, so the result goes behind it, in
    // front of the first message that is.
    const initial = [text("u1", "user"), call("a1", "c1"), activity("act"), text("a2")];
    const messages = await afterSnapshot(
      [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "act", "t1", "a2"]);
  });
});

describe("keepToolResultsWithCalls", () => {
  it("returns the same array when every result is in place", () => {
    const messages = [
      text("u1", "user"),
      call("a1", "c1", "c2"),
      activity("act"),
      result("t2", "c2"),
      result("t1", "c1"),
      text("a2"),
    ];

    const repaired = keepToolResultsWithCalls(messages);

    expect(repaired).toBe(messages);
    expect(ids(repaired)).toEqual(["u1", "a1", "act", "t2", "t1", "a2"]);
  });

  it("returns the same array when nothing issues a tool call", () => {
    const messages = [text("u1", "user"), result("orphan", "missing"), text("a1")];

    const repaired = keepToolResultsWithCalls(messages);

    expect(repaired).toBe(messages);
    expect(ids(repaired)).toEqual(["u1", "orphan", "a1"]);
  });

  it("returns a new array and leaves the input untouched when it moves a result", () => {
    const messages = [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")];

    const repaired = keepToolResultsWithCalls(messages);

    expect(repaired).not.toBe(messages);
    expect(ids(repaired)).toEqual(["u1", "a1", "t1", "a2"]);
    expect(ids(messages)).toEqual(["u1", "a1", "a2", "t1"]);
  });
});
