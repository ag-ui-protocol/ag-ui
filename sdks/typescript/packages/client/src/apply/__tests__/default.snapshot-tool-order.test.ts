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

  it("does not move a result past client-only activity that follows its call", async () => {
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
    // snapshot object. The local history has no "t1", so the merge appends the
    // snapshot's result at the end, after the text.
    const initial = [text("u1", "user"), call("a1", "c1"), call("a1", "c1"), text("a2")];
    const messages = await afterSnapshot(
      [text("u1", "user"), call("a1", "c1"), text("a2"), result("t1", "c1")],
      initial,
    );

    expect(ids(messages)).toEqual(["u1", "a1", "t1", "a1", "a2"]);
  });

  it("moves one copy of a result the merge aliases twice and leaves the other", async () => {
    // Two local results share the id "t1" and both map to the snapshot's copy.
    // They are two slots: the first answers a1 and moves, the second finds no
    // unanswered call and stays. Nothing is dropped.
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

  it("leaves a result in place when only activity separates it from its call", async () => {
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

  it("pairs several detached results with a reused id in call order", () => {
    // Both calls issue "c" and neither is answered in place, so the first
    // result answers the first call and the second the second (FIFO).
    const messages = [
      call("a1", "c"),
      call("a2", "c"),
      text("x"),
      result("t1", "c"),
      result("t2", "c"),
    ];

    expect(ids(keepToolResultsWithCalls(messages))).toEqual(["a1", "t1", "a2", "t2", "x"]);
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
    const messages = [
      null,
      call("a1", "c1"),
      42,
      result("t1", "c1"),
      { id: "a2", role: "assistant", toolCalls: null },
    ] as unknown as Message[];

    const repaired = keepToolResultsWithCalls(messages);

    expect(repaired).toEqual([messages[0], messages[1], messages[3], 42, messages[4]]);
  });
});

// Property test: random histories, checked against the invariants the function
// promises. Seeded so a failure reproduces; the seed and index are in the message.
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
  const separates = (m: unknown) => !isTool(m) && roleOf(m) !== "activity";

  const ID_POOL = ["c0", "c1", "c2"];

  function randomHistory(random: () => number): Message[] {
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
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
        const message = call(id, ...calls);
        if (random() < 0.1) (message as { toolCalls: unknown[] }).toolCalls.push(null);
        history.push(message);
      } else if (kind === 2) history.push(text(id));
      else if (kind === 3) history.push(reasoning(id));
      else if (kind === 4 || kind === 5) history.push(result(id, pick([...ID_POOL, "missing"])));
      else if (random() < 0.5) history.push(activity(id));
      else history.push(null as unknown as Message);
    }
    return history;
  }

  // The pairing the documented rule produces, computed independently:
  // moved result index -> issuer index.
  function expectedMoves(history: Message[]): Map<number, number> {
    const open: { id: string; issuer: number }[] = [];
    const moves = new Map<number, number>();
    let anchor = -1;
    history.forEach((message, index) => {
      if (isTool(message)) {
        const id = (message as { toolCallId?: unknown }).toolCallId;
        const inPlace = open.findIndex((slot) => slot.id === id && slot.issuer === anchor);
        const oldest = open.findIndex((slot) => slot.id === id);
        const slot = inPlace >= 0 ? inPlace : oldest;
        if (slot < 0) return;
        if (inPlace < 0) moves.set(index, open[slot].issuer);
        open.splice(slot, 1);
      } else if (separates(message)) {
        anchor = index;
        const toolCalls = (message as { toolCalls?: unknown } | null)?.toolCalls;
        if (roleOf(message) !== "assistant" || !Array.isArray(toolCalls)) return;
        for (const entry of toolCalls) {
          const id = (entry as { id?: unknown } | null)?.id;
          if (typeof id === "string") open.push({ id, issuer: index });
        }
      }
    });
    return moves;
  }

  const counts = (list: unknown[]) => {
    const map = new Map<unknown, number>();
    for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const sameSequence = (a: unknown[], b: unknown[]) =>
    a.length === b.length && a.every((item, i) => item === b[i]);

  it("holds its invariants over thousands of random histories", () => {
    const seed = 0x3114;
    const random = prng(seed);
    let movedCases = 0;
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

      const moves = expectedMoves(history);
      if (moves.size === 0) {
        expect(repaired, where).toBe(history);
        continue;
      }
      movedCases++;
      expect(repaired, where).not.toBe(history);
      expect(sameSequence(repaired, history), where).toBe(false);

      // Every moved result ends right behind its issuer: the issuer's run of
      // tool/activity messages ends with its moved results, in input order.
      const nonToolOutputIndex: number[] = [];
      repaired.forEach((m, i) => {
        if (!isTool(m)) nonToolOutputIndex.push(i);
      });
      const nonToolRank = new Map<number, number>();
      history.forEach((m, i) => {
        if (!isTool(m)) nonToolRank.set(i, nonToolRank.size);
      });
      const owed = new Map<number, number[]>();
      for (const [resultIndex, issuer] of moves) {
        owed.set(issuer, [...(owed.get(issuer) ?? []), resultIndex]);
      }
      for (const [issuer, results] of owed) {
        const at = nonToolOutputIndex[nonToolRank.get(issuer)!];
        let end = at + 1;
        while (end < repaired.length && !separates(repaired[end])) end++;
        const tail = repaired.slice(end - results.length, end);
        expect(end - results.length > at, where).toBe(true);
        expect(
          sameSequence(
            tail,
            results.map((i) => history[i]),
          ),
          where,
        ).toBe(true);
      }
    }
    // The generator must actually exercise moves.
    expect(movedCases).toBeGreaterThan(250);
  });
});
