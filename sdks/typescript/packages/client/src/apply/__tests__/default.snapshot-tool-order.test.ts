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
  const withMessages = updates.filter((update) => update.messages);
  expect(withMessages.length).toBeGreaterThan(0);
  return withMessages[withMessages.length - 1].messages!;
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
    const messages = await afterSnapshot(broken, broken);

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
    const messages = await afterSnapshot(
      [...initial, result("t2", "c2"), result("t3", "c3")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "t2", "a2", "a3", "t3", "a4"]);
  });

  it("never moves an early result past an answered call onto a later pending one", () => {
    const history = [
      result("t0", "c"),
      call("a1", "c"),
      result("t1", "c"),
      text("u2", "user"),
      call("a2", "c"),
    ];

    expect(keepToolResultsWithCalls(history)).toBe(history);
  });

  it("keeps the original order of detached results for different calls moved to one message", () => {
    const history = [call("a1", "c1", "c2"), text("x"), result("t1", "c1"), result("t2", "c2")];

    expect(ids(keepToolResultsWithCalls(history))).toEqual(["a1", "t1", "t2", "x"]);
    expect(ids(keepToolResultsWithCalls([history[0], history[1], history[3], history[2]]))).toEqual(
      ["a1", "t2", "t1", "x"],
    );
  });

  it("moves a large batch of detached results without overflowing the call stack", () => {
    const n = 150_000;
    const callIds = Array.from({ length: n }, (_, i) => `c${i}`);
    const results = callIds.map((id, i) => result(`t${i}`, id));
    // Built directly: call("a1", ...callIds) would itself spread n arguments.
    const issuer: Message = {
      ...call("a1"),
      toolCalls: callIds.map((id) => ({
        id,
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      })),
    } as Message;
    const history = [issuer, text("x"), ...results];

    const repaired = keepToolResultsWithCalls(history);

    expect(repaired).toHaveLength(history.length);
    expect(repaired[0].id).toBe("a1");
    expect(repaired[1].id).toBe("t0");
    expect(repaired[n].id).toBe(`t${n - 1}`);
    expect(repaired[n + 1].id).toBe("x");
  });

  it("leaves a result whose call is not in the history where it is", async () => {
    const snapshot = [
      text("u1", "user"),
      result("orphan", "missing"),
      text("a1"),
      call("a2", "c2"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "orphan", "a1", "a2"]);
  });

  it("leaves a correctly ordered snapshot unchanged", async () => {
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1", "c2"),
      result("t2", "c2"),
      result("t1", "c1"),
      text("a2"),
    ];

    expect(await afterSnapshot(snapshot)).toEqual(snapshot);
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

  it("does not pull a later turn's result back to an earlier unanswered call with the same id", async () => {
    // a1's call_0 was abandoned and never answered. The provider reuses
    // call_0 in the next turn, so t3 answers a3, the nearest earlier call with
    // its id. Pairing with the oldest open call would drag t3 back across u2.
    const snapshot = [
      text("u1", "user"),
      call("a1", "call_0"),
      text("x"),
      text("u2", "user"),
      call("a3", "call_0"),
      text("y"),
      result("t3", "call_0"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "x", "u2", "a3", "t3", "y"]);
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

  it("keeps each turn's result with its own turn when a reload re-ids every result", async () => {
    // After a reload the first snapshot re-ids every tool message, so the
    // merge appends all of them at the end. The provider reused call_0 in both
    // turns. Each result goes back to its own turn, in order, not swapped.
    const initial = [
      text("u1", "user"),
      call("a1", "call_0"),
      text("a1t"),
      text("u2", "user"),
      call("a2", "call_0"),
      text("a2t"),
    ];
    const messages = await afterSnapshot(
      [...initial, result("t1", "call_0"), result("t2", "call_0")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a1t", "u2", "a2", "t2", "a2t"]);
  });

  it("moves a duplicate result for an answered call back to an older abandoned call", async () => {
    // a1's call_0 was abandoned. a3 reuses call_0 and is answered in place by
    // t3; t3dup is a second result for it. The pass cannot tell a duplicate
    // from a late answer to a1, so it takes the only open call_0 and moves
    // back across u2. Every result still follows a call with its id.
    const snapshot = [
      text("u1", "user"),
      call("a1", "call_0"),
      text("x"),
      text("u2", "user"),
      call("a3", "call_0"),
      result("t3", "call_0"),
      text("y"),
      result("t3dup", "call_0"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual([
      "u1",
      "a1",
      "t3dup",
      "x",
      "u2",
      "a3",
      "t3",
      "y",
    ]);
  });

  it("leaves one copy of a merge-duplicated call unanswered", async () => {
    // Two local messages share the id "a1", so the merge maps both to the same
    // snapshot object. The local history has no "t1", so the merge appends the
    // snapshot's result at the end, after the text. The pass never drops or
    // dedupes, so the duplicate is two calls: t1 answers the nearer copy and
    // the earlier copy stays unanswered. The result is emitted once.
    const initial = [text("u1", "user"), call("a1", "c1"), call("a1", "c1"), text("a2")];
    const messages = await afterSnapshot(
      [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "a1", "t1", "a2"]);
  });

  it("moves one copy of a result the merge aliases twice and leaves the other", async () => {
    // Two local results share the id "t1" and both map to the snapshot's copy.
    // They are two slots, both detached. Matching from the newest back, the
    // second answers a1 and moves, and the first finds no unanswered call left
    // and stays. Nothing is dropped.
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

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a2", "t1"]);
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

  it("leaves a result behind reasoning stored between it and its call", async () => {
    // Reasoning there is the next step's; moving the result in front of it
    // leaves it trailing, and Mastra drops it.
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1"),
      reasoning("r1"),
      result("t1", "c1"),
      text("a2"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "r1", "t1", "a2"]);
  });

  it("keeps a multi-step turn's later reasoning ahead of the result appended after it", () => {
    const history = [
      text("u1", "user"),
      reasoning("r1"),
      call("a1", "c-lookup", "c-chart"),
      result("t-lookup", "c-lookup"),
      reasoning("r2"),
      result("t-chart", "c-chart"),
    ];

    expect(keepToolResultsWithCalls(history)).toBe(history);
  });

  it("moves a detached result back in front of reasoning, which stays with the message after it", () => {
    // Converters give reasoning to the message after it. Landing the result
    // between r1 and a1t would hand r1 to the result: LangGraph drops it, and
    // Mastra moves encrypted reasoning onto a1's call.
    const history = [
      text("u1", "user"),
      call("a1", "c1"),
      reasoning("r1"),
      text("a1t"),
      result("t1", "c1"),
    ];

    expect(ids(keepToolResultsWithCalls(history))).toEqual(["u1", "a1", "t1", "r1", "a1t"]);
  });

  it("moves a detached result in front of reasoning that follows its call's other results", () => {
    const history = [
      text("u1", "user"),
      call("a1", "c1", "c2"),
      result("t1", "c1"),
      reasoning("r2"),
      text("a1t"),
      result("t2", "c2"),
    ];

    expect(ids(keepToolResultsWithCalls(history))).toEqual(["u1", "a1", "t1", "t2", "r2", "a1t"]);
  });

  it("looks past activity after reasoning when placing a moved result", () => {
    // Activity is stripped before a run, so `a1 r1 act t1 a1t` would go out as
    // `a1 r1 t1 a1t`.
    const history = [
      call("a1", "c1"),
      reasoning("r1"),
      activity("act"),
      text("a1t"),
      result("t1", "c1"),
    ];

    expect(ids(keepToolResultsWithCalls(history))).toEqual(["a1", "t1", "r1", "act", "a1t"]);
  });

  it("moves a result before a user message that separates it from its call", async () => {
    const snapshot = [text("u1", "user"), call("a1", "c1"), text("u2", "user"), result("t1", "c1")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "u2"]);
  });

  it("moves a result that sits before its call forward to that call", async () => {
    // Nothing earlier issued c1, so the result answers the first later call.
    const snapshot = [text("u1", "user"), result("t1", "c1"), call("a1", "c1"), text("a2")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "a2"]);
  });

  it("moves a result before its call forward when that call ends the list", async () => {
    const snapshot = [text("u1", "user"), result("t1", "c1"), call("a1", "c1")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1"]);
  });

  it("puts the result back after its call when the snapshot re-ids the assistant message", async () => {
    // The snapshot keeps the result's id but re-ids the call and the text, so
    // the merge keeps the local result in place and appends the new call after
    // it: [u, t, a1', txt'].
    const initial = [text("u", "user"), call("a1", "c"), result("t", "c"), text("txt")];
    const messages = await afterSnapshot(
      [text("u", "user"), call("a1-snapshot", "c"), result("t", "c"), text("txt-snapshot")],
      initial,
    );

    expect(ids(messages)).toEqual(["u", "a1-snapshot", "t", "txt-snapshot"]);
  });

  it("keeps reasoning before its call when a result moves forward past both", async () => {
    const snapshot = [text("u", "user"), result("t", "c"), reasoning("r"), call("a", "c")];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u", "r", "a", "t"]);
  });

  it("does not move a result forward onto a call that is answered in place", async () => {
    // a's call is answered by t1 directly behind it, so t0 has no open call.
    const snapshot = [
      text("u", "user"),
      result("t0", "c"),
      call("a", "c"),
      result("t1", "c"),
      text("x"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u", "t0", "a", "t1", "x"]);
  });

  it("does not move an extra result for an answered call forward onto a later pending call", async () => {
    // t1 answers a1's call_0, so t1dup is an extra result for a call that
    // already has one. a2 reuses call_0 and is still pending (a
    // human-in-the-loop call waiting on the user). Moving t1dup forward would
    // answer a2 with a1's result, so nothing moves and a2 stays unanswered.
    const snapshot = [
      text("u1", "user"),
      call("a1", "call_0"),
      result("t1", "call_0"),
      text("x"),
      result("t1dup", "call_0"),
      text("u2", "user"),
      call("a2", "call_0"),
    ];

    expect(keepToolResultsWithCalls(snapshot)).toBe(snapshot);
    expect(await afterSnapshot(snapshot)).toEqual(snapshot);
  });

  it("does not move early results forward when their call id is reused across turns", () => {
    // call_0 is issued by both a1 and a2, so which call an early result
    // answers is a guess; a2 may be a human-in-the-loop call still waiting on
    // the user. Nothing moves.
    const t = result("t", "call_0");
    const messages = [
      t,
      t,
      call("a1", "call_0"),
      text("x"),
      text("u2", "user"),
      call("a2", "call_0"),
    ];

    expect(keepToolResultsWithCalls(messages)).toBe(messages);
  });

  it("does not move distinct early results forward onto calls that reuse their id", () => {
    const messages = [
      result("t0", "c"),
      result("t1", "c"),
      call("a1", "c"),
      text("x"),
      call("a2", "c"),
      text("y"),
    ];

    expect(keepToolResultsWithCalls(messages)).toBe(messages);
  });

  it("moves an early result forward to the one call that issues its unique id", () => {
    // The snapshot re-ids the assistant message (a1') but keeps the result.
    const messages = [text("u", "user"), result("t", "c1"), text("txt"), call("a1-prime", "c1")];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["u", "txt", "a1-prime", "t"]);
  });

  it("moves only the first of two early results for one unique call forward", () => {
    const messages = [result("t0", "c"), result("t1", "c"), call("a", "c"), text("x")];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["t1", "a", "t0", "x"]);
  });

  it("emits a forward-moved result before a backward-moved one for the same issuer", () => {
    // Both answer a1 (calls c1, c2); moved results keep their original order.
    const messages = [result("t1", "c1"), call("a1", "c1", "c2"), text("x"), result("t2", "c2")];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["a1", "t1", "t2", "x"]);
  });

  it("leaves extra results for a call that is already answered where they are", async () => {
    // One call takes one result. The extras pair with nothing, so they stay.
    const snapshot = [
      text("u1", "user"),
      call("a1", "c1"),
      result("t1", "c1"),
      text("a2"),
      result("t1b", "c1"),
      result("t1c", "c1"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u1", "a1", "t1", "a2", "t1b", "t1c"]);
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

  it("leaves a result in place when only preserved activity separates it from its call", async () => {
    // The snapshot carries no activity, so the local activity is preserved
    // between the call and its result. Activity never goes to the backend, so
    // the result is already in place and nothing moves.
    const initial = [
      text("u1", "user"),
      call("a1", "c1"),
      activity("act"),
      result("t1", "c1"),
      text("a2"),
    ];
    const messages = await afterSnapshot(
      [text("u1", "user"), call("a1", "c1"), result("t1", "c1"), text("a2")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "act", "t1", "a2"]);
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

describe("tool results pair with calls by id alone, whatever their subagent run", () => {
  const sub = (message: Message, subagentRunId = "r1") =>
    ({ ...message, subagentRunId }) as Message;

  // A tool result's subagentRunId names the run that executed it, which can
  // differ from the run that issued the call, so the run never keys pairing.

  it("lands a streamed result after its call when its subagent run differs", async () => {
    const initial = [text("u", "user"), call("a", "c"), text("x")];

    const messages = await finalMessages(
      [
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "ta",
          toolCallId: "c",
          content: "a",
          subagentRunId: "r1",
        },
        { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
      ] as BaseEvent[],
      initial,
    );

    expect(ids(messages)).toEqual(["u", "a", "ta", "x"]);
    // A later snapshot of that history leaves it where it is.
    expect(keepToolResultsWithCalls(messages)).toBe(messages);
  });

  it("moves a snapshot result to its call when its subagent run differs", async () => {
    const snapshot = [text("u", "user"), call("a", "c"), text("x"), sub(result("ta", "c"))];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u", "a", "ta", "x"]);
  });

  it("cannot tell apart a parent and a subagent call that reuse one id (known limitation)", async () => {
    // Pairing is by id only. A parent call and a subagent call both issue
    // "c", and both results drifted. Newest back, the last result (ta, the
    // parent's) takes the newest open call (s, the subagent's) and ts takes
    // a: each call is answered once, but the two results are swapped.
    const snapshot = [
      text("u", "user"),
      call("a", "c"),
      sub(call("s", "c")),
      text("x"),
      sub(result("ts", "c")),
      result("ta", "c"),
    ];

    expect(ids(await afterSnapshot(snapshot))).toEqual(["u", "a", "ts", "s", "ta", "x"]);
  });
});

describe("TOOL_CALL_RESULT places a streamed result like the snapshot pass", () => {
  const streamResult = (initial: Message[], messageId: string, toolCallId: string) =>
    finalMessages(
      [
        { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId,
          toolCallId,
          content: `result of ${toolCallId}`,
        },
        { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
      ] as BaseEvent[],
      initial,
    );

  it("lands a streamed result with a reused id after the latest call with that id", async () => {
    // The provider reuses call_0 every turn. The result answers this turn's
    // call, not the first one in history.
    const initial = [
      text("u1", "user"),
      call("a1", "call_0"),
      result("t1", "call_0"),
      text("a2"),
      text("u2", "user"),
      call("a3", "call_0"),
    ];

    const messages = await streamResult(initial, "t3", "call_0");

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a2", "u2", "a3", "t3"]);
  });

  it("lands a streamed result after the newest call with its id that has no result yet", async () => {
    // a2's call "c" is answered by t2, so t1 answers a1, not the newest holder.
    const initial = [text("u", "user"), call("a1", "c"), call("a2", "c"), result("t2", "c")];

    const messages = await streamResult(initial, "t1", "c");

    expect(ids(messages)).toEqual(["u", "a1", "t1", "a2", "t2"]);
    // A later snapshot of that history leaves it where it is.
    expect(ids(await afterSnapshot(messages, messages))).toEqual(ids(messages));
  });

  it("lands a streamed result after the newest holder when every holder is answered", async () => {
    const initial = [
      text("u", "user"),
      call("a1", "c"),
      result("t1", "c"),
      call("a2", "c"),
      result("t2", "c"),
      text("x"),
    ];

    const messages = await streamResult(initial, "t3", "c");

    expect(ids(messages)).toEqual(["u", "a1", "t1", "a2", "t2", "t3", "x"]);
  });

  it("does not throw on malformed toolCalls in history", async () => {
    const initial = [
      text("u", "user"),
      { id: "a0", role: "assistant", toolCalls: [null] },
      { id: "a1", role: "assistant", toolCalls: { id: "c" } },
      call("a2", "c"),
      { id: "a3", role: "assistant", toolCalls: [null, 42] },
      text("x"),
    ] as unknown as Message[];

    const messages = await streamResult(initial, "t2", "c");

    expect(ids(messages)).toEqual(["u", "a0", "a1", "a2", "t2", "a3", "x"]);
  });

  it("lands a streamed result after activity that follows its call", async () => {
    const initial = [text("u1", "user"), call("a1", "c1"), activity("act"), text("a2")];

    const messages = await streamResult(initial, "t1", "c1");

    expect(ids(messages)).toEqual(["u1", "a1", "act", "t1", "a2"]);
    // The snapshot pass puts the same result in the same place.
    expect(ids(keepToolResultsWithCalls([...initial, result("t1", "c1")]))).toEqual(ids(messages));
  });
});

describe("MESSAGES_SNAPSHOT stopped by a subscriber", () => {
  it("skips the repair along with the rest of the snapshot", async () => {
    const broken = [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")];
    const agent = createAgent(broken);
    const updates = await firstValueFrom(
      defaultApplyEvents(
        createInput(broken),
        from([
          { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
          { type: EventType.MESSAGES_SNAPSHOT, messages: broken },
          { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
        ] as BaseEvent[]),
        agent,
        [{ onMessagesSnapshotEvent: () => ({ stopPropagation: true }) }],
      ).pipe(toArray()),
    );

    expect(updates.filter((update) => update.messages)).toEqual([]);
  });

  it("repairs the same snapshot when no subscriber stops it", async () => {
    // Control for the case above: without the subscriber the order is repaired.
    const broken = [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")];

    expect(ids(await afterSnapshot(broken, broken))).toEqual(["u1", "a1", "t1", "a2"]);
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

  it("pairs several detached results with a reused id in call order", () => {
    // Both calls issue "c" and neither is answered in place. Matching from the
    // newest back, t2 takes a2 and t1 takes a1, so the results keep their turns.
    const messages = [
      call("a1", "c"),
      call("a2", "c"),
      text("x"),
      result("t1", "c"),
      result("t2", "c"),
    ];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["a1", "t1", "a2", "t2", "x"]);
  });

  it("leaves a detached result that has no open call left where it is", () => {
    // Matching from the newest back, t2 takes the only open call; t1 stays.
    const messages = [call("a1", "c"), text("x"), result("t1", "c"), result("t2", "c")];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["a1", "t2", "x", "t1"]);
  });

  it("does not let a null entry separate a call from its result", () => {
    const messages = [call("a1", "c"), null, result("t1", "c")] as unknown as Message[];

    expect(keepToolResultsWithCalls(messages)).toBe(messages);
  });

  it("moves a result behind null entries that follow its call", () => {
    const messages = [call("a1", "c"), null, text("x"), result("t1", "c")] as unknown as Message[];

    expect(keepToolResultsWithCalls(messages)).toEqual([
      messages[0],
      null,
      messages[3],
      messages[2],
    ]);
  });

  it("leaves a drifted result alone when every earlier call with its id is answered", () => {
    const messages = [
      text("u1", "user"),
      call("a1", "c"),
      result("t1", "c"),
      call("a2", "c"),
      result("t2", "c"),
      text("x"),
      result("t3", "c"),
    ];

    const repaired = keepToolResultsWithCalls(messages);

    expect(repaired).toBe(messages);
    expect(ids(repaired)).toEqual(["u1", "a1", "t1", "a2", "t2", "x", "t3"]);
  });

  it("keeps a result in place after the second copy of an aliased call", () => {
    // One object twice is two calls. t1 sits after the second copy and answers
    // it; t2 answers the first copy, which has no result, so only t2 moves.
    const aliased = call("a1", "c");
    const messages = [text("u1", "user"), aliased, aliased, result("t1", "c"), result("t2", "c")];

    const repaired = keepToolResultsWithCalls(messages);

    expect(ids(repaired)).toEqual(["u1", "a1", "t2", "a1", "t1"]);
    expect(repaired[1]).toBe(aliased);
    expect(repaired[3]).toBe(aliased);
  });

  it("moves detached results behind the right copy of an aliased call", () => {
    const aliased = call("a1", "c");
    const messages = [aliased, text("x"), aliased, text("y"), result("t1", "c"), result("t2", "c")];

    // Matching from the newest back: t2 takes the later copy, t1 the earlier.
    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["a1", "t1", "x", "a1", "t2", "y"]);
  });

  it("emits a moved result after an orphan that sits between it and its call", () => {
    // The orphan answers nothing and stays directly after a1; t1 lands behind it.
    const messages = [
      text("u1", "user"),
      call("a1", "c1"),
      result("orphan", "missing"),
      text("a2"),
      result("t1", "c1"),
    ];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["u1", "a1", "orphan", "t1", "a2"]);
  });

  it("does not throw on null or non-object messages and passes them through", () => {
    // 42 is transparent, so t1 is already in place behind a1.
    const messages = [
      null,
      call("a1", "c1"),
      42,
      result("t1", "c1"),
      { id: "a2", role: "assistant", toolCalls: null },
    ] as unknown as Message[];

    expect(keepToolResultsWithCalls(messages)).toBe(messages);
  });
});

// Property test: random histories, checked against invariants that hold for
// any correct pairing rule. It does not re-implement the rule (a copy of a
// wrong rule would agree with it); the examples above pin the rule down.
// Seeded so a failure reproduces; the message names the seed and the run.
describe("keepToolResultsWithCalls properties", () => {
  // mulberry32
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const roleOf = (m: unknown) =>
    typeof m === "object" && m !== null ? (m as { role?: unknown }).role : undefined;
  const isTool = (m: unknown) => roleOf(m) === "tool";
  // Null and non-object entries are transparent: they never separate.
  const separates = (m: unknown) =>
    typeof m === "object" &&
    m !== null &&
    !isTool(m) &&
    roleOf(m) !== "activity" &&
    roleOf(m) !== "reasoning";
  const runOf = (m: unknown) => {
    const run = (m as { subagentRunId?: unknown } | null)?.subagentRunId;
    return typeof run === "string" ? run : "";
  };
  // How many call slots `m` opens that the tool message `t` can answer: calls
  // with its id, whatever either's subagent run.
  const slotsFor = (m: unknown, t: unknown) => {
    const toolCalls = (m as { toolCalls?: unknown } | null)?.toolCalls;
    if (roleOf(m) !== "assistant" || !Array.isArray(toolCalls)) return 0;
    const id = (t as { toolCallId?: unknown }).toolCallId;
    return toolCalls.filter(
      (entry) =>
        typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === id,
    ).length;
  };

  const ID_POOL = ["c0", "c1", "c2"];

  function randomHistory(random: () => number): Message[] {
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    // Some calls and results carry a subagent run, which pairing ignores.
    const maybeSub = (message: Message): Message =>
      random() < 0.3 ? ({ ...message, subagentRunId: "r1" } as Message) : message;
    const length = Math.floor(random() * 12);
    const history: Message[] = [];
    for (let i = 0; i < length; i++) {
      if (history.length > 0 && random() < 0.15) {
        history.push(pick(history)); // alias an earlier object
        continue;
      }
      const kind = Math.floor(random() * 7);
      const id = `m${i}`;
      if (kind === 0) history.push(text(id, "user"));
      else if (kind === 1) {
        const calls = Array.from({ length: Math.floor(random() * 4) }, () => pick(ID_POOL));
        const message = maybeSub(call(id, ...calls));
        if (random() < 0.1) (message as { toolCalls: unknown[] }).toolCalls.push(null);
        history.push(message);
      } else if (kind === 2) history.push(text(id));
      else if (kind === 3) history.push(reasoning(id));
      else if (kind === 4 || kind === 5)
        history.push(maybeSub(result(id, pick([...ID_POOL, "missing"]))));
      else if (random() < 0.5) history.push(activity(id));
      else history.push(null as unknown as Message);
    }
    // A reload re-ids every result, so the merge appends them all at the end:
    // several detached results, often sharing one reused id.
    if (random() < 0.3) {
      const id = pick(ID_POOL);
      const count = 1 + Math.floor(random() * 3);
      for (let i = 0; i < count; i++) history.push(result(`r${i}`, id));
    }
    return history;
  }

  const counts = (list: unknown[]) => {
    const map = new Map<unknown, number>();
    for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const sameSequence = (a: unknown[], b: unknown[]) =>
    a.length === b.length && a.every((item, i) => item === b[i]);

  // Maps each output slot back to the input index it came from. The function
  // works by position, never identity, so it is run on a copy where every
  // object slot is a distinct shallow clone; the clone names its index. Null
  // and non-object entries are never tool messages and keep their relative
  // order (checked separately), so they are matched up in order.
  function outputSources(history: Message[]): { sources: number[]; output: Message[] } {
    const indexOf = new Map<unknown, number>();
    const distinct = history.map((m, i) => {
      if (typeof m !== "object" || m === null) return m;
      const clone = { ...m };
      indexOf.set(clone, i);
      return clone;
    });
    const output = keepToolResultsWithCalls(distinct);
    const nonObjects = history.flatMap((m, i) => (typeof m !== "object" || m === null ? [i] : []));
    let nextNonObject = 0;
    const sources = output.map((m) => indexOf.get(m) ?? nonObjects[nextNonObject++]);
    return { sources, output: sources.map((i) => history[i]) };
  }

  it("holds its invariants over thousands of random histories", () => {
    const seed = 0x3114;
    const random = prng(seed);
    let movedCases = 0;
    let sharedIdMoves = 0;
    let movesBehindNull = 0;
    let forwardMoves = 0;
    let crossRunMoves = 0;
    for (let run = 0; run < 5000; run++) {
      const history = randomHistory(random);
      const snapshot = [...history];
      const where = `seed ${seed}, run ${run}`;

      const repaired = keepToolResultsWithCalls(history);

      // The input is never mutated.
      expect(sameSequence(history, snapshot), where).toBe(true);
      // A permutation of the input slots: same references, same counts.
      expect(repaired.length, where).toBe(history.length);
      expect(counts(repaired), where).toEqual(counts(history));
      // Only tool messages move.
      expect(
        sameSequence(
          repaired.filter((m) => !isTool(m)),
          history.filter((m) => !isTool(m)),
        ),
        where,
      ).toBe(true);
      // Idempotent.
      expect(sameSequence(keepToolResultsWithCalls(repaired), repaired), where).toBe(true);

      // Position-only: the same input with aliases split apart gives the same
      // output, slot for slot.
      const { sources, output } = outputSources(history);
      expect(sameSequence(output, repaired), where).toBe(true);
      expect(
        [...sources].sort((a, b) => a - b),
        where,
      ).toEqual(history.map((_, i) => i));

      // A result is moved when a different number of non-tool messages
      // precede it in the output than in the input: fewer when it moved back,
      // more when it moved forward.
      const nonToolsBefore = (list: number[], at: number) =>
        list.slice(0, at).filter((i) => !isTool(history[i])).length;
      const inputOrder = history.map((_, i) => i);
      const moved = new Set<number>();
      sources.forEach((source, at) => {
        if (!isTool(history[source])) return;
        const before = nonToolsBefore(inputOrder, source);
        const after = nonToolsBefore(sources, at);
        if (after !== before) moved.add(source);
        if (after > before) {
          forwardMoves++;
          // Only a result whose id is on exactly one call slot in the whole
          // history moves forward, and that slot is issued after it.
          const slotCount = (list: unknown[]) =>
            list.reduce<number>((sum, m) => sum + slotsFor(m, history[source]), 0);
          expect(slotCount(history), where).toBe(1);
          expect(slotCount(history.slice(0, source)), where).toBe(0);
        }
      });

      if (moved.size === 0) {
        expect(repaired, where).toBe(history);
        continue;
      }
      movedCases++;
      expect(repaired, where).not.toBe(history);
      // A moved result never lands right after reasoning, looking past
      // activity, null and non-object entries: reasoning keeps the message
      // after it.
      sources.forEach((source, at) => {
        if (!moved.has(source)) return;
        for (let before = at - 1; before >= 0; before--) {
          const entry = repaired[before];
          if (typeof entry !== "object" || entry === null || roleOf(entry) === "activity") continue;
          expect(roleOf(entry), where).not.toBe("reasoning");
          break;
        }
      });
      const movedIds = [...moved].map((i) => (history[i] as { toolCallId?: unknown }).toolCallId);
      if (new Set(movedIds).size < movedIds.length) sharedIdMoves++;

      // Removing the moved results from the output leaves exactly the input
      // with those indices removed: every other slot keeps its order, so a
      // result that was not moved keeps its position among them.
      expect(
        sources.filter((i) => !moved.has(i)),
        where,
      ).toEqual(inputOrder.filter((i) => !moved.has(i)));

      // Every moved result sits after an assistant message that issues a call
      // with its id, with only tool, activity, null and non-object entries in
      // between. Count the moves each such call slot takes, keyed by the
      // issuer's input index and the result's id.
      const movesTo = new Map<string, number>();
      let behindNull = false;
      let crossRun = false;
      sources.forEach((source, at) => {
        if (!moved.has(source)) return;
        let issuer = at - 1;
        while (issuer >= 0 && !separates(repaired[issuer])) issuer--;
        expect(issuer >= 0 && slotsFor(repaired[issuer], history[source]) > 0, where).toBe(true);
        if (repaired.slice(issuer + 1, at).some((m) => m === null)) behindNull = true;
        if (runOf(repaired[issuer]) !== runOf(history[source])) crossRun = true;
        const t = history[source] as { toolCallId?: unknown };
        const slot = JSON.stringify([sources[issuer], t.toolCallId]);
        movesTo.set(slot, (movesTo.get(slot) ?? 0) + 1);
      });
      if (behindNull) movesBehindNull++;
      if (crossRun) crossRunMoves++;
      // Moves only answer open slots, and never one slot twice: the results
      // already in place behind an issuer in the input plus the ones moved to
      // it never outnumber the matching calls it issues. In-place results are
      // capped at the call count (Math.min) because extras beyond it answer
      // nothing; they stay put and must not count as taken slots.
      for (const [slot, count] of movesTo) {
        const [issuer, id] = JSON.parse(slot) as [number, string];
        const calls = slotsFor(history[issuer], { role: "tool", toolCallId: id });
        let inPlace = 0;
        for (let i = issuer + 1; i < history.length && !separates(history[i]); i++) {
          const t = history[i] as { toolCallId?: unknown };
          if (isTool(t) && t.toolCallId === id) inPlace++;
        }
        expect(Math.min(inPlace, calls) + count <= calls, where).toBe(true);
      }
    }
    // The generator must actually exercise moves.
    expect(movedCases).toBeGreaterThan(250);
    // ...including several moved results for one reused id, and moves that
    // land behind a null entry following the issuer.
    expect(sharedIdMoves).toBeGreaterThan(50);
    expect(movesBehindNull).toBeGreaterThan(40);
    // ...and forward moves of results that sit before their call, and moves
    // that pair a result with a call from a different subagent run.
    expect(forwardMoves).toBeGreaterThan(100);
    expect(crossRunMoves).toBeGreaterThan(100);
    // Well under a second alone, but CI runs every package's suite at once.
  }, 60_000);
});
