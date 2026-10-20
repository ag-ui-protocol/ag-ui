/**
 * Server-managed history (ag-ui-protocol/ag-ui#2186): in "server" mode a run
 * uploads only the messages the server has not confirmed, plus a cursor in
 * forwardedProps naming the last confirmed message. A RUN_ERROR with code
 * HISTORY_UNAVAILABLE is answered by one transparent retry with full history.
 */
import { AbstractAgent, HISTORY_CURSOR_KEY, HISTORY_UNAVAILABLE_CODE } from "../agent";
import { HttpAgent } from "../http";
import {
  AgentCapabilities,
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
} from "@ag-ui/core";
import { Observable, Subject, of } from "rxjs";
import type { AgentConfig, HistoryMode } from "../types";
import type { AgentSubscriber } from "../subscriber";

type Responder = (input: RunAgentInput, call: number) => BaseEvent[];

/** Replies with scripted events and records a copy of every input it was sent. */
class ScriptedAgent extends AbstractAgent {
  public inputs: RunAgentInput[] = [];
  public asyncDelivery = false;

  constructor(
    config: AgentConfig,
    public respond: Responder = replyWith(),
  ) {
    super(config);
    this.debug = false;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const call = this.inputs.length;
    this.inputs.push(structuredClone(input));
    const events = this.respond(input, call);
    if (!this.asyncDelivery) {
      return of(...events);
    }
    const subject = new Subject<BaseEvent>();
    queueMicrotask(() => {
      events.forEach((event) => subject.next(event));
      subject.complete();
    });
    return subject;
  }
}

const user = (id: string, content = id): Message => ({ id, role: "user", content });

const started = (input: RunAgentInput): BaseEvent =>
  ({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId }) as BaseEvent;
const finished = (input: RunAgentInput): BaseEvent =>
  ({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId }) as BaseEvent;
const historyUnavailable = (): BaseEvent =>
  ({
    type: EventType.RUN_ERROR,
    message: "unknown cursor",
    code: HISTORY_UNAVAILABLE_CODE,
  }) as BaseEvent;
const text = (id: string, delta = id): BaseEvent[] =>
  [
    { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta },
    { type: EventType.TEXT_MESSAGE_END, messageId: id },
  ] as BaseEvent[];

/** A normal run: started, one assistant reply named after the call, finished. */
const replyWith =
  (prefix = "a"): Responder =>
  (input, call) => [started(input), ...text(`${prefix}${call + 1}`), finished(input)];

const ids = (messages: Message[]) => messages.map((m) => m.id);
const cursorOf = (input: RunAgentInput) =>
  (input.forwardedProps as Record<string, unknown> | undefined)?.[HISTORY_CURSOR_KEY];

/** Runs three user turns, adding u1..u3 before each. */
async function threeTurns(agent: AbstractAgent) {
  for (const id of ["u1", "u2", "u3"]) {
    agent.addMessage(user(id));
    await agent.runAgent();
  }
}

describe("historyMode: full (default)", () => {
  it("uploads the whole history on every run and never sets a cursor", async () => {
    const agent = new ScriptedAgent({});
    await threeTurns(agent);

    expect(agent.historyMode).toBe("full");
    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([
      ["u1"],
      ["u1", "a1", "u2"],
      ["u1", "a1", "u2", "a2", "u3"],
    ]);
    expect(agent.inputs.every((i) => cursorOf(i) === undefined)).toBe(true);
  });

  it("leaves a caller-supplied cursor key alone", async () => {
    const agent = new ScriptedAgent({});
    await agent.runAgent({ forwardedProps: { [HISTORY_CURSOR_KEY]: "mine" } });
    expect(cursorOf(agent.inputs[0])).toBe("mine");
  });
});

describe("historyMode: server", () => {
  it("uploads only unconfirmed messages and the last confirmed id as the cursor", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await threeTurns(agent);

    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(agent.inputs.map(cursorOf)).toEqual([undefined, "a1", "a2"]);
    // The agent's own history is complete.
    expect(ids(agent.messages)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
  });

  it("works the same when events arrive asynchronously", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.asyncDelivery = true;
    await threeTurns(agent);

    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(agent.inputs.map(cursorOf)).toEqual([undefined, "a1", "a2"]);
  });

  it("sends initial messages in full on the first run", async () => {
    const agent = new ScriptedAgent({
      historyMode: "server",
      initialMessages: [user("u0"), { id: "a0", role: "assistant", content: "earlier" }],
    });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    expect(ids(agent.inputs[0].messages)).toEqual(["u0", "a0", "u1"]);
    expect(cursorOf(agent.inputs[0])).toBeUndefined();
  });

  it("keeps caller forwardedProps next to the cursor", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await agent.runAgent({ forwardedProps: { tenant: "t1" } });
    agent.addMessage(user("u2"));
    await agent.runAgent({ forwardedProps: { tenant: "t1", [HISTORY_CURSOR_KEY]: "forged" } });

    expect(agent.inputs[1].forwardedProps).toEqual({ tenant: "t1", [HISTORY_CURSOR_KEY]: "a1" });
  });

  it("removes a caller-supplied cursor when nothing is confirmed yet", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await agent.runAgent({ forwardedProps: { [HISTORY_CURSOR_KEY]: "forged" } });
    expect(agent.inputs[0].forwardedProps).toEqual({});
  });

  it("falls back to full history when forwardedProps cannot carry a cursor", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent({ forwardedProps: "opaque" });
    expect(ids(agent.inputs[1].messages)).toEqual(["a1", "u2"]);
    expect(agent.inputs[1].forwardedProps).toBe("opaque");
  });

  it("uploads a client-side tool result that answers a confirmed tool call", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 0
        ? ([
            started(input),
            { type: EventType.TOOL_CALL_START, toolCallId: "tc1", toolCallName: "lookup", parentMessageId: "a1" },
            { type: EventType.TOOL_CALL_ARGS, toolCallId: "tc1", delta: "{}" },
            { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
            finished(input),
          ] as BaseEvent[])
        : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage({ id: "t1", role: "tool", toolCallId: "tc1", content: "42" });
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["t1"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("does not confirm messages from a run that ended without RUN_FINISHED", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? ([started(input), { type: EventType.RUN_ERROR, message: "boom" }] as BaseEvent[])
        : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();
    agent.addMessage(user("u3"));
    await agent.runAgent();

    // u2 was sent but never confirmed, so it travels again with u3.
    expect(ids(agent.inputs[2].messages)).toEqual(["u2", "u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("a1");
  });

  it("confirms everything a MESSAGES_SNAPSHOT delivers", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 0
        ? ([
            started(input),
            {
              type: EventType.MESSAGES_SNAPSHOT,
              messages: [user("s1"), { id: "s2", role: "assistant", content: "stored" }],
            },
            { type: EventType.RUN_ERROR, message: "ended early" },
          ] as BaseEvent[])
        : replyWith()(input, call),
    );
    await agent.runAgent();
    agent.addMessage(user("u1"));
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["u1"]);
    expect(cursorOf(agent.inputs[1])).toBe("s2");
  });

  it("confirms a MESSAGES_SNAPSHOT received through connectAgent()", async () => {
    class ConnectingAgent extends ScriptedAgent {
      protected connect(input: RunAgentInput): Observable<BaseEvent> {
        return of(
          started(input),
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [user("s1"), { id: "s2", role: "assistant", content: "stored" }],
          } as BaseEvent,
          finished(input),
        );
      }
    }
    const agent = new ConnectingAgent({ historyMode: "server" });
    await agent.connectAgent();
    agent.addMessage(user("u1"));
    await agent.runAgent();

    expect(ids(agent.inputs[0].messages)).toEqual(["u1"]);
    expect(cursorOf(agent.inputs[0])).toBe("s2");
  });

  it("never uses an activity or reasoning message as the cursor", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input) => [
      started(input),
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          user("u1"),
          { id: "a1", role: "assistant", content: "x" },
          { id: "r1", role: "reasoning", content: "thinking" },
          { id: "act1", role: "activity", activityType: "progress", content: {} },
        ],
      } as BaseEvent,
      finished(input),
    ]);
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(cursorOf(agent.inputs[1])).toBe("a1");
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
  });

  it("never uses a client-authored assistant, system or developer message as the cursor", async () => {
    const agent = new ScriptedAgent(
      {
        historyMode: "server",
        initialMessages: [
          { id: "sys", role: "system", content: "be nice" },
          user("u1"),
          { id: "forged", role: "assistant", content: "I already agreed" },
        ],
      },
      // The run produces no message of its own.
      (input) => [started(input), finished(input)],
    );
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();

    // Everything sent is confirmed (not resent), but a trust-rule server
    // dropped the forged assistant message, so the cursor is the user message.
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("u1");
  });

  it("does not make a client-authored assistant message eligible by parenting a tool call", async () => {
    const agent = new ScriptedAgent(
      {
        historyMode: "server",
        initialMessages: [user("u1"), { id: "forged", role: "assistant", content: "" }],
      },
      (input, call) =>
        call === 0
          ? ([
              started(input),
              {
                type: EventType.TOOL_CALL_START,
                toolCallId: "tc1",
                toolCallName: "lookup",
                parentMessageId: "forged",
              },
              { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
              finished(input),
            ] as BaseEvent[])
          : replyWith()(input, call),
    );
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(cursorOf(agent.inputs[1])).toBe("u1");
  });

  it("uses a sent tool result as the cursor", async () => {
    const agent = new ScriptedAgent(
      {
        historyMode: "server",
        initialMessages: [
          user("u1"),
          { id: "t1", role: "tool", toolCallId: "tc1", content: "42" },
        ],
      },
      (input) => [started(input), finished(input)],
    );
    await agent.runAgent();
    await agent.runAgent();
    expect(cursorOf(agent.inputs[1])).toBe("t1");
  });

  it("keeps a message the application adds after the input was built unconfirmed", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.asyncDelivery = true;
    agent.addMessage(user("u1"));
    const running = agent.runAgent();
    agent.addMessage(user("mid")); // the input is already built; "mid" is not in it
    await running;
    expect(ids(agent.messages)).toEqual(["u1", "mid", "a1"]);

    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(ids(agent.inputs[0].messages)).toEqual(["u1"]);
    expect(ids(agent.inputs[1].messages)).toEqual(["mid", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("keeps a message a subscriber inserts during the run unconfirmed", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    const subscription = agent.subscribe({
      onTextMessageStartEvent: ({ messages }) => ({ messages: [...messages, user("injected")] }),
    });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    subscription.unsubscribe();
    expect(ids(agent.messages)).toContain("injected");

    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["injected", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("applies activity strip, then delta, then messageFilter", async () => {
    const seen: string[][] = [];
    const agent = new ScriptedAgent({
      historyMode: "server",
      messageFilter: (messages) => {
        seen.push(ids(messages));
        return messages;
      },
    });
    await agent.runAgent();
    agent.addMessages([
      user("u2"),
      { id: "act", role: "activity", activityType: "progress", content: {} },
    ]);
    await agent.runAgent();

    expect(seen[1]).toEqual(["u2"]);
  });

  it("does not confirm a message the messageFilter withheld", async () => {
    let withhold = true;
    const agent = new ScriptedAgent({
      historyMode: "server",
      messageFilter: (messages) =>
        withhold ? messages.filter((m) => m.id !== "secret") : messages,
    });
    agent.addMessages([user("secret"), user("u1")]);
    await agent.runAgent();
    withhold = false;
    agent.addMessage(user("u2"));
    await agent.runAgent();

    // "secret" was never uploaded, so the server cannot have it: still pending.
    expect(ids(agent.inputs[0].messages)).toEqual(["u1"]);
    expect(ids(agent.inputs[1].messages)).toEqual(["secret", "u2"]);
  });

  it("re-applies the delta when onRunInitialized replaces the messages", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await agent.runAgent();
    const unsubscribe = agent.subscribe({
      onRunInitialized: ({ messages }) => ({ messages: [...messages, user("injected")] }),
    }).unsubscribe;
    agent.addMessage(user("u2"));
    await agent.runAgent();
    unsubscribe();

    expect(ids(agent.inputs[1].messages)).toEqual(["u2", "injected"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("resets confirmation when threadId changes", async () => {
    const agent = new ScriptedAgent({ historyMode: "server", threadId: "t1" });
    await agent.runAgent();
    agent.threadId = "t2";
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["a1", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBeUndefined();
  });

  it("resets confirmation when setMessages replaces the history", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.setMessages([user("u1")]); // rewind past a1
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["u1", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBeUndefined();
  });

  it("resetConfirmedHistory() forces the next run to upload everything", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await agent.runAgent();
    agent.resetConfirmedHistory();
    await agent.runAgent();
    expect(ids(agent.inputs[1].messages)).toEqual(["a1"]);
    expect(cursorOf(agent.inputs[1])).toBeUndefined();
  });

  it("clone() keeps the mode and an independent copy of the confirmed set", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await agent.runAgent();

    const cloned = agent.clone() as ScriptedAgent;
    // clone() skips subclass field initializers; give the copy its own script.
    cloned.inputs = [];
    cloned.respond = replyWith("c");
    expect(cloned.historyMode).toBe("server");
    cloned.addMessage(user("u2"));
    await cloned.runAgent();
    expect(ids(cloned.inputs[0].messages)).toEqual(["u2"]);
    expect(cursorOf(cloned.inputs[0])).toBe("a1");

    // The clone's confirmations do not leak back into the original.
    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("HttpAgent.clone() keeps the history mode and confirmations", async () => {
    const agent = new HttpAgent({ url: "https://example.com", historyMode: "server" });
    const cloned = agent.clone();
    expect(cloned.historyMode).toBe("server");
    expect(cloned.usesServerHistory).toBe(true);
  });
});

describe("HISTORY_UNAVAILABLE fallback", () => {
  function watch(agent: AbstractAgent) {
    const seen = {
      types: [] as string[],
      failed: 0,
      inputs: [] as RunAgentInput[],
    };
    agent.subscribe({
      onEvent: ({ event }) => {
        seen.types.push(event.type);
      },
      onRunFailed: () => {
        seen.failed++;
      },
      onRunFinalized: ({ input }) => {
        seen.inputs.push(structuredClone(input));
      },
    } as AgentSubscriber);
    return seen;
  }

  const refuseCall =
    (refused: number[], afterStart = true): Responder =>
    (input, call) =>
      refused.includes(call)
        ? afterStart
          ? [started(input), historyUnavailable()]
          : [historyUnavailable()]
        : replyWith()(input, call);

  it.each([
    ["after RUN_STARTED", true, false],
    ["as the first event", false, false],
    ["after RUN_STARTED, delivered asynchronously", true, true],
  ])("retries once with full history when refused %s", async (_name, afterStart, isAsync) => {
    const agent = new ScriptedAgent({ historyMode: "server" }, refuseCall([1], afterStart));
    agent.asyncDelivery = isAsync;
    agent.addMessage(user("u1"));
    await agent.runAgent();
    const seen = watch(agent);
    agent.addMessage(user("u2"));
    const result = await agent.runAgent();

    expect(agent.inputs).toHaveLength(3);
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
    expect(ids(agent.inputs[2].messages)).toEqual(["u1", "a1", "u2"]);
    expect(cursorOf(agent.inputs[2])).toBeUndefined();
    expect(agent.inputs[2].runId).toBe(agent.inputs[1].runId);

    // Subscribers see one clean run: one RUN_STARTED, no RUN_ERROR.
    expect(seen.types.filter((t) => t === EventType.RUN_STARTED)).toHaveLength(1);
    expect(seen.types).not.toContain(EventType.RUN_ERROR);
    expect(seen.failed).toBe(0);
    // And the input they are handed is what the retry actually sent.
    expect(ids(seen.inputs[0].messages)).toEqual(["u1", "a1", "u2"]);
    expect(result.newMessages.map((m) => m.id)).toEqual(["a3"]);

    // The retry's RUN_FINISHED confirmed the history: the next run is a delta again.
    agent.addMessage(user("u3"));
    await agent.runAgent();
    expect(ids(agent.inputs[3].messages)).toEqual(["u3"]);
    expect(cursorOf(agent.inputs[3])).toBe("a3");
  });

  it("does not loop: a refused retry surfaces as an ordinary RUN_ERROR", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, refuseCall([1, 2]));
    await agent.runAgent();
    const seen = watch(agent);
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(agent.inputs).toHaveLength(3);
    expect(seen.types).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
  });

  it("does not retry when no cursor was sent", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, refuseCall([0]));
    const seen = watch(agent);
    await agent.runAgent();

    expect(agent.inputs).toHaveLength(1);
    expect(seen.types).toContain(EventType.RUN_ERROR);
  });

  it("does not retry in full mode", async () => {
    const agent = new ScriptedAgent({}, refuseCall([1]));
    await agent.runAgent();
    const seen = watch(agent);
    await agent.runAgent();

    expect(agent.inputs).toHaveLength(2);
    expect(seen.types).toContain(EventType.RUN_ERROR);
  });

  it("does not retry a refusal that follows other output", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? [started(input), ...text("partial"), historyUnavailable()]
        : replyWith()(input, call),
    );
    await agent.runAgent();
    const seen = watch(agent);
    await agent.runAgent();

    expect(agent.inputs).toHaveLength(2);
    expect(seen.types).toContain(EventType.RUN_ERROR);
  });

  it("delivers the first attempt's RUN_STARTED without waiting for the next event", async () => {
    const live = new Subject<BaseEvent>();
    let call = 0;
    class LiveAgent extends ScriptedAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        this.inputs.push(structuredClone(input));
        return call++ === 0 ? of(...replyWith()(input, 0)) : live;
      }
    }
    const agent = new LiveAgent({ historyMode: "server" });
    await agent.runAgent();
    const seen: string[] = [];
    agent.subscribe({ onEvent: ({ event }) => void seen.push(event.type) });

    const running = agent.runAgent({ runId: "r2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    live.next({ type: EventType.RUN_STARTED, threadId: agent.threadId, runId: "r2" } as BaseEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([EventType.RUN_STARTED]);

    live.next({ type: EventType.RUN_FINISHED, threadId: agent.threadId, runId: "r2" } as BaseEvent);
    live.complete();
    await running;
    expect(seen).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("passes other RUN_ERROR codes through untouched", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? ([started(input), { type: EventType.RUN_ERROR, message: "x", code: "OTHER" }] as BaseEvent[])
        : replyWith()(input, call),
    );
    await agent.runAgent();
    const seen = watch(agent);
    await agent.runAgent();

    expect(agent.inputs).toHaveLength(2);
    expect(seen.types).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
  });
});

describe("historyMode: auto", () => {
  class CapableAgent extends ScriptedAgent {
    public capabilityCalls = 0;
    constructor(
      mode: HistoryMode,
      private answer: () => Promise<AgentCapabilities>,
    ) {
      super({ historyMode: mode });
    }
    getCapabilities = async () => {
      this.capabilityCalls++;
      return this.answer();
    };
  }

  it.each([
    ["state.serverManagedHistory", { state: { serverManagedHistory: true } } as AgentCapabilities],
    ["custom.serverManagedHistory", { custom: { serverManagedHistory: true } }],
  ])("uses server mode when %s is advertised, asking once", async (_name, capabilities) => {
    const agent = new CapableAgent("auto", async () => capabilities);
    await threeTurns(agent);

    expect(agent.capabilityCalls).toBe(1);
    expect(agent.usesServerHistory).toBe(true);
    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([["u1"], ["u2"], ["u3"]]);
  });

  it("uses full mode when the capability is absent", async () => {
    const agent = new CapableAgent("auto", async () => ({ state: { snapshots: true } }));
    await threeTurns(agent);

    expect(agent.capabilityCalls).toBe(1);
    expect(agent.usesServerHistory).toBe(false);
    expect(ids(agent.inputs[2].messages)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
  });

  it("falls back to full history when the lookup fails, and asks again next run", async () => {
    let fail = true;
    const agent = new CapableAgent("auto", async () => {
      if (fail) throw new Error("offline");
      return { custom: { serverManagedHistory: true } };
    });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    fail = false;
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(agent.capabilityCalls).toBe(2);
    expect(cursorOf(agent.inputs[0])).toBeUndefined();
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("ignores a lookup that finishes after historyMode was reassigned", async () => {
    let resolveFirst!: (caps: AgentCapabilities) => void;
    const answers = [
      new Promise<AgentCapabilities>((resolve) => (resolveFirst = resolve)),
      Promise.resolve<AgentCapabilities>({}),
    ];
    const agent = new CapableAgent("auto", () => answers.shift()!);
    const first = agent.runAgent();
    await Promise.resolve();
    agent.historyMode = "auto"; // discards the in-flight lookup
    resolveFirst({ custom: { serverManagedHistory: true } });
    await first;
    expect(agent.usesServerHistory).toBe(false);

    await agent.runAgent();
    expect(agent.capabilityCalls).toBe(2);
    expect(agent.usesServerHistory).toBe(false);
  });

  it("picks up a getCapabilities assigned after construction", async () => {
    const agent = new ScriptedAgent({ historyMode: "auto" });
    await agent.runAgent();
    expect(agent.usesServerHistory).toBe(false);
    agent.getCapabilities = async () => ({ custom: { serverManagedHistory: true } });
    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(agent.usesServerHistory).toBe(true);
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
  });

  it("uses full mode for an agent without getCapabilities", async () => {
    const agent = new ScriptedAgent({ historyMode: "auto" });
    await threeTurns(agent);
    expect(agent.usesServerHistory).toBe(false);
    expect(ids(agent.inputs[1].messages)).toEqual(["u1", "a1", "u2"]);
  });

  it("does not call getCapabilities in full or server mode", async () => {
    const full = new CapableAgent("full", async () => ({}));
    const server = new CapableAgent("server", async () => ({}));
    await full.runAgent();
    await server.runAgent();
    expect(full.capabilityCalls + server.capabilityCalls).toBe(0);
  });
});
