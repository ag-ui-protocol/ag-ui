/**
 * Server-managed history (ag-ui-protocol/ag-ui#2186): in "server" mode a run
 * uploads only the messages the server has not confirmed, plus a cursor in
 * forwardedProps naming the last confirmed message. A RUN_ERROR with code
 * HISTORY_UNAVAILABLE is answered by one transparent retry with full history.
 */
import { AbstractAgent, HISTORY_CURSOR_KEY, HISTORY_UNAVAILABLE_CODE } from "../agent";
import { HttpAgent } from "../http";
import { AgentCapabilities, BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
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
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tc1",
              toolCallName: "lookup",
              parentMessageId: "a1",
            },
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

    // The owning assistant message travels with its result (decision 1).
    expect(ids(agent.inputs[1].messages)).toEqual(["a1", "t1"]);
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

    // The system message travels on every run. Everything else sent is
    // confirmed (not resent), but a trust-rule server dropped the forged
    // assistant message, so the cursor is the user message.
    expect(ids(agent.inputs[1].messages)).toEqual(["sys", "u2"]);
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
        initialMessages: [user("u1"), { id: "t1", role: "tool", toolCallId: "tc1", content: "42" }],
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

  it("applies the delta when onRunInitialized replaces the messages", async () => {
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
        ? ([
            started(input),
            { type: EventType.RUN_ERROR, message: "x", code: "OTHER" },
          ] as BaseEvent[])
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

describe("server history: the transport step", () => {
  const toolCallTurn =
    (owner: string, toolCallId: string): Responder =>
    (input) =>
      [
        started(input),
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: "lookup",
          parentMessageId: owner,
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" },
        { type: EventType.TOOL_CALL_END, toolCallId },
        finished(input),
      ] as BaseEvent[];

  it("shows middlewares the full history while the transport sends the delta", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    const seenByMiddleware: string[][] = [];
    agent.use((input, next) => {
      seenByMiddleware.push(ids(input.messages));
      return next.run(input);
    });
    await threeTurns(agent);

    expect(seenByMiddleware).toEqual([["u1"], ["u1", "a1", "u2"], ["u1", "a1", "u2", "a2", "u3"]]);
    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(agent.inputs.map(cursorOf)).toEqual([undefined, "a1", "a2"]);
  });

  it("sends the delta on a middleware continuation run and confirms both uploads", async () => {
    // Call 0 is turn 1. Turn 2 asks for a tool (call 1); the middleware runs
    // the tool and continues with the result (call 2), like the MCP middleware.
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1 ? toolCallTurn("a2", "tc1")(input, call) : replyWith()(input, call),
    );
    agent.use((input, next) => {
      return new Observable<BaseEvent>((out) => {
        let askedForTool = false;
        next.run(input).subscribe({
          next: (event) => {
            if (event.type === EventType.TOOL_CALL_START) askedForTool = true;
            if (event.type !== EventType.RUN_FINISHED) out.next(event);
          },
          complete: () => {
            if (!askedForTool) {
              out.next(finished(input));
              out.complete();
              return;
            }
            const owner: Message = {
              id: "a2",
              role: "assistant",
              toolCalls: [
                { id: "tc1", type: "function", function: { name: "lookup", arguments: "{}" } },
              ],
            };
            const result: Message = { id: "t1", role: "tool", toolCallId: "tc1", content: "42" };
            next.messages.push(result);
            next.run({ ...input, messages: [...input.messages, owner, result] }).subscribe({
              next: (event) => {
                if (event.type !== EventType.RUN_STARTED) out.next(event);
              },
              complete: () => out.complete(),
            });
          },
        });
      });
    });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();
    agent.addMessage(user("u3"));
    await agent.runAgent();

    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([
      ["u1"],
      ["u2"],
      // The continuation carries the still unconfirmed u2, the tool call
      // owner and its result, after the same cursor.
      ["u2", "a2", "t1"],
      ["u3"],
    ]);
    expect(agent.inputs.map(cursorOf)).toEqual([undefined, "a1", "a1", "a3"]);
  });

  it("retries a HISTORY_UNAVAILABLE refusal of a middleware continuation run", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 2 ? [historyUnavailable()] : replyWith()(input, call),
    );
    let continued = false;
    agent.use((input, next) => {
      if (input.messages.length < 3 || continued) return next.run(input);
      continued = true;
      // Run once, then continue once with the same history, as one run.
      return new Observable<BaseEvent>((out) => {
        next.run(input).subscribe({
          next: (event) => {
            if (event.type !== EventType.RUN_FINISHED) out.next(event);
          },
          complete: () =>
            next.run({ ...input, runId: "continuation" }).subscribe({
              next: (event) => {
                if (event.type !== EventType.RUN_STARTED) out.next(event);
              },
              complete: () => out.complete(),
            }),
        });
      });
    });
    const errors: string[] = [];
    agent.subscribe({ onRunErrorEvent: ({ event }) => void errors.push(event.message) });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(agent.inputs).toHaveLength(4);
    expect(cursorOf(agent.inputs[2])).toBe("a1");
    // The refused continuation is retried once, with everything and no cursor.
    expect(ids(agent.inputs[3].messages)).toEqual(["u1", "a1", "u2"]);
    expect(cursorOf(agent.inputs[3])).toBeUndefined();
    expect(agent.inputs[3].runId).toBe("continuation");
    expect(errors).toEqual([]);
  });

  it("keeps the owner in original order when an unconfirmed message sits between", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 0 ? toolCallTurn("a1", "tc1")(input, call) : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessages([user("note"), { id: "t1", role: "tool", toolCallId: "tc1", content: "42" }]);
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["a1", "note", "t1"]);
  });

  it("puts back an owner the messageFilter dropped next to its kept result", async () => {
    const agent = new ScriptedAgent(
      {
        historyMode: "server",
        messageFilter: (messages) => messages.filter((m) => m.role !== "assistant"),
      },
      (input, call) =>
        call === 0 ? toolCallTurn("a1", "tc1")(input, call) : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage({ id: "t1", role: "tool", toolCallId: "tc1", content: "42" });
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["a1", "t1"]);
  });

  it("sends system and developer messages on every run", async () => {
    const agent = new ScriptedAgent({
      historyMode: "server",
      initialMessages: [
        { id: "sys", role: "system", content: "be brief" },
        { id: "dev", role: "developer", content: "use metric units" },
      ],
    });
    await threeTurns(agent);

    expect(agent.inputs.map((i) => ids(i.messages))).toEqual([
      ["sys", "dev", "u1"],
      ["sys", "dev", "u2"],
      ["sys", "dev", "u3"],
    ]);
    expect(agent.inputs.map(cursorOf)).toEqual([undefined, "a1", "a2"]);
  });

  it("does not treat an edited system message as divergence", async () => {
    const agent = new ScriptedAgent({
      historyMode: "server",
      initialMessages: [{ id: "sys", role: "system", content: "v1" }],
    });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    (agent.messages[0] as { content: string }).content = "v2";
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["sys", "u2"]);
    expect(agent.inputs[1].messages[0]).toMatchObject({ content: "v2" });
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });
});

describe("server history: divergence", () => {
  it("sends the full history once, without a cursor, after a confirmed message is edited", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await threeTurns(agent);
    agent.messages = agent.messages.map((m) => (m.id === "u2" ? user("u2", "edited") : m));
    agent.addMessage(user("u4"));
    await agent.runAgent();
    agent.addMessage(user("u5"));
    await agent.runAgent();

    expect(ids(agent.inputs[3].messages)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "u4"]);
    expect(cursorOf(agent.inputs[3])).toBeUndefined();
    expect(agent.inputs[3].messages[2]).toMatchObject({ content: "edited" });
    // The full upload was confirmed, so the delta resumes.
    expect(ids(agent.inputs[4].messages)).toEqual(["u5"]);
    expect(cursorOf(agent.inputs[4])).toBe("a4");
  });

  it("catches an edit made by a subscriber mutation", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    const subscription = agent.subscribe({
      onRunInitialized: ({ messages }) => ({
        messages: messages.map((m) =>
          m.id === "a1" ? ({ ...m, content: "rewritten" } as Message) : (m as Message),
        ),
      }),
    });
    agent.addMessage(user("u2"));
    await agent.runAgent();
    subscription.unsubscribe();

    expect(ids(agent.inputs[1].messages)).toEqual(["u1", "a1", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBeUndefined();
  });

  it("sends the full history after a confirmed message is removed directly", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    await threeTurns(agent);
    agent.messages = agent.messages.slice(0, 2); // regenerate after a1
    agent.addMessage(user("u2b"));
    await agent.runAgent();

    expect(ids(agent.inputs[3].messages)).toEqual(["u1", "a1", "u2b"]);
    expect(cursorOf(agent.inputs[3])).toBeUndefined();
  });

  it("keeps the delta when setMessages only appends", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.setMessages([...agent.messages, user("u2")]);
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("does not count a change the run's own events made as divergence", async () => {
    // Run 2 adds a tool call to the confirmed a1 instead of creating a message.
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? ([
            started(input),
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tc1",
              toolCallName: "x",
              parentMessageId: "a1",
            },
            { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
            finished(input),
          ] as BaseEvent[])
        : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();
    agent.addMessage(user("u3"));
    await agent.runAgent();

    expect(ids(agent.inputs[2].messages)).toEqual(["u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("u2");
  });

  it("clone() copies the fingerprinted confirmations independently", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    const cloned = agent.clone() as ScriptedAgent;
    cloned.inputs = [];
    cloned.respond = replyWith("c");
    cloned.messages = [user("u1", "edited in the clone"), ...cloned.messages.slice(1)];
    cloned.addMessage(user("u2"));
    await cloned.runAgent();
    expect(cursorOf(cloned.inputs[0])).toBeUndefined();

    // The original never diverged.
    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(ids(agent.inputs[1].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });
});

describe("server history: other entry points", () => {
  it("does not mutate the caller's input on a HISTORY_UNAVAILABLE retry", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1 ? [started(input), historyUnavailable()] : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    const handed: RunAgentInput[] = [];
    agent.use((input, next) => {
      handed.push(input);
      return next.run(input);
    });
    agent.addMessage(user("u2"));
    await agent.runAgent({ forwardedProps: { tenant: "t1" } });

    expect(agent.inputs).toHaveLength(3);
    expect(ids(handed[0].messages)).toEqual(["u1", "a1", "u2"]);
    expect(handed[0].forwardedProps).toEqual({ tenant: "t1" });
  });

  it("the legacy bridge always sends the full history without a cursor", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await new Promise<void>((resolve) =>
      agent
        .legacy_to_be_removed_runAgentBridged({ forwardedProps: { [HISTORY_CURSOR_KEY]: "x" } })
        .subscribe({ complete: () => resolve(), error: () => resolve() }),
    );

    expect(ids(agent.inputs[1].messages)).toEqual(["u1", "a1", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBeUndefined();
  });

  it("connectAgent() sends the delta through the transport step", async () => {
    const connected: RunAgentInput[] = [];
    class ConnectingAgent extends ScriptedAgent {
      protected connect(input: RunAgentInput): Observable<BaseEvent> {
        connected.push(structuredClone(input));
        return of(started(input), finished(input));
      }
    }
    const agent = new ConnectingAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.connectAgent();

    expect(ids(connected[0].messages)).toEqual(["u2"]);
    expect(cursorOf(connected[0])).toBe("a1");
  });
});

describe("MESSAGES_SNAPSHOT and client instructions", () => {
  const snapshotWithout = (input: RunAgentInput): BaseEvent[] => [
    started(input),
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [user("u1"), { id: "a1", role: "assistant", content: "stored" }],
    } as BaseEvent,
    finished(input),
  ];
  const instructions: Message[] = [
    { id: "sys", role: "system", content: "be brief" },
    { id: "dev", role: "developer", content: "metric units" },
  ];

  it("keeps local system and developer messages a server-mode snapshot omits", async () => {
    const agent = new ScriptedAgent(
      { historyMode: "server", initialMessages: instructions },
      (input, call) => (call === 0 ? snapshotWithout(input) : replyWith()(input, call)),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    expect(ids(agent.messages)).toEqual(["sys", "dev", "u1", "a1"]);

    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(ids(agent.inputs[1].messages)).toEqual(["sys", "dev", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
  });

  it("keeps full mode snapshot semantics unchanged", async () => {
    const agent = new ScriptedAgent({ initialMessages: instructions }, snapshotWithout);
    agent.addMessage(user("u1"));
    await agent.runAgent();
    expect(ids(agent.messages)).toEqual(["u1", "a1"]);
  });
});

describe("server history: MESSAGES_SNAPSHOT rebases the confirmations", () => {
  const snapshotRun =
    (messages: Message[]): Responder =>
    (input) => [
      started(input),
      { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent,
      finished(input),
    ];

  it("keeps the system message, the cursor and the delta after a snapshot that omits it", async () => {
    const agent = new ScriptedAgent(
      {
        historyMode: "server",
        initialMessages: [{ id: "sys", role: "system", content: "be brief" }],
      },
      (input, call) =>
        call === 1
          ? snapshotRun([user("u1"), { id: "a1", role: "assistant", content: "a1" }, user("u2")])(
              input,
              call,
            )
          : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent(); // answered by the snapshot only
    agent.addMessage(user("u3"));
    await agent.runAgent();

    expect(ids(agent.messages)).toEqual(["sys", "u1", "a1", "u2", "u3", "a3"]);
    expect(ids(agent.inputs[2].messages)).toEqual(["sys", "u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("u2");
  });

  it("drops ids a later snapshot leaves out, and adopts its content, without a full resend", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? snapshotRun([
            user("u1"),
            { id: "a1", role: "assistant", content: "rewritten by the server" },
            user("u2"),
            { id: "a2", role: "assistant", content: "a2" },
          ])(input, call)
        : replyWith()(input, call),
    );
    agent.addMessages([user("u1"), user("dropped")]);
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(ids(agent.messages)).toEqual(["u1", "a1", "u2", "a2"]);

    agent.addMessage(user("u3"));
    await agent.runAgent();
    expect(ids(agent.inputs[2].messages)).toEqual(["u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("a2");
  });

  it("sends a message added while a run streamed in the next delta, and adopts the snapshot's order", async () => {
    // Run 1 streams a1 while the application adds "mid"; the client holds
    // mid before a1. Run 2 sends mid after the cursor, so the server stores it
    // after a1. That order difference is not a divergence: the next delta is
    // normal, and the snapshot run 2 ends with puts the client in the
    // server's order.
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? snapshotRun([
            user("u1"),
            { id: "a1", role: "assistant", content: "a1" },
            user("mid"),
            user("u2"),
            { id: "a2", role: "assistant", content: "a2" },
          ])(input, call)
        : replyWith()(input, call),
    );
    agent.asyncDelivery = true;
    agent.addMessage(user("u1"));
    const running = agent.runAgent();
    agent.addMessage(user("mid"));
    await running;
    expect(ids(agent.messages)).toEqual(["u1", "mid", "a1"]);

    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(ids(agent.inputs[1].messages)).toEqual(["mid", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBe("a1");
    expect(ids(agent.messages)).toEqual(["u1", "a1", "mid", "u2", "a2"]);

    agent.addMessage(user("u3"));
    await agent.runAgent();
    expect(ids(agent.inputs[2].messages)).toEqual(["u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("a2");
  });

  it("without a snapshot, the differing order of such a message is not a divergence", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.asyncDelivery = true;
    agent.addMessage(user("u1"));
    const running = agent.runAgent();
    agent.addMessage(user("mid"));
    await running;
    agent.addMessage(user("u2"));
    await agent.runAgent();
    agent.addMessage(user("u3"));
    await agent.runAgent();

    expect(ids(agent.inputs[2].messages)).toEqual(["u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("a2");
  });
});

describe("server history: review edge cases", () => {
  it("does not resend a confirmed reasoning message a snapshot without reasoning keeps", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) => {
      if (call === 0) {
        return [
          started(input),
          { type: EventType.REASONING_START, messageId: "r1" },
          { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" },
          { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "hmm" },
          { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
          { type: EventType.REASONING_END, messageId: "r1" },
          ...text("a1"),
          finished(input),
        ] as BaseEvent[];
      }
      if (call === 1) {
        return [
          started(input),
          {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [
              user("u1"),
              { id: "a1", role: "assistant", content: "a1" },
              user("u2"),
              { id: "a2", role: "assistant", content: "a2" },
            ],
          },
          finished(input),
        ] as BaseEvent[];
      }
      return replyWith()(input, call);
    });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();
    expect(ids(agent.messages)).toContain("r1");
    agent.addMessage(user("u3"));
    await agent.runAgent();

    expect(ids(agent.inputs[2].messages)).toEqual(["u3"]);
    expect(cursorOf(agent.inputs[2])).toBe("a2");
  });

  it("sends the full history when setMessages inserts a message before a confirmed one", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" });
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.setMessages([user("u0"), ...agent.messages, user("u2")]);
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["u0", "u1", "a1", "u2"]);
    expect(cursorOf(agent.inputs[1])).toBeUndefined();
  });

  it("does not count the run's own change to a confirmed message as divergence in a continuation", async () => {
    // Turn 2 adds a tool call to the confirmed a1; a middleware then
    // continues the run, which must still be a delta.
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 1
        ? ([
            started(input),
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tc1",
              toolCallName: "x",
              parentMessageId: "a1",
            },
            { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
            finished(input),
          ] as BaseEvent[])
        : replyWith()(input, call),
    );
    agent.asyncDelivery = true;
    let continued = false;
    agent.use(
      (input, next) =>
        new Observable<BaseEvent>((out) => {
          if (continued || input.messages.length < 3) {
            return next.run(input).subscribe(out);
          }
          continued = true;
          next.run(input).subscribe({
            next: (event) => {
              if (event.type !== EventType.RUN_FINISHED) out.next(event);
            },
            complete: () =>
              // Let the pipeline apply the tool call to a1 first.
              setTimeout(() =>
                next.run(input).subscribe({
                  next: (event) => {
                    if (event.type !== EventType.RUN_STARTED) out.next(event);
                  },
                  complete: () => out.complete(),
                }),
              ),
          });
        }),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(agent.messages.find((m) => m.id === "a1")).toMatchObject({
      toolCalls: [expect.objectContaining({ id: "tc1" })],
    });
    expect(ids(agent.inputs[2].messages)).toEqual(["u2"]);
    expect(cursorOf(agent.inputs[2])).toBe("a1");
  });

  it("detects an edit to a resent message made while the run streamed", async () => {
    const agent = new ScriptedAgent({ historyMode: "server" }, (input, call) =>
      call === 0
        ? ([
            started(input),
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: "tc1",
              toolCallName: "lookup",
              parentMessageId: "a1",
            },
            { type: EventType.TOOL_CALL_END, toolCallId: "tc1" },
            finished(input),
          ] as BaseEvent[])
        : replyWith()(input, call),
    );
    agent.addMessage(user("u1"));
    await agent.runAgent();
    agent.addMessage({ id: "t1", role: "tool", toolCallId: "tc1", content: "42" });
    // Resends a1 as the owner of t1; a subscriber edits it mid-stream.
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ messages }) => ({
        messages: messages.map((m) =>
          m.id === "a1" ? ({ ...m, content: "edited while streaming" } as Message) : m,
        ),
      }),
    });
    await agent.runAgent();
    subscription.unsubscribe();
    agent.addMessage(user("u2"));
    await agent.runAgent();

    expect(ids(agent.inputs[1].messages)).toEqual(["a1", "t1"]);
    expect(cursorOf(agent.inputs[2])).toBeUndefined();
  });

  it("reports a messageFilter that throws as a failed run", async () => {
    const agent = new ScriptedAgent({
      historyMode: "server",
      messageFilter: () => {
        throw new Error("filter broke");
      },
    });
    const failures: string[] = [];
    agent.subscribe({
      onRunFailed: ({ error }) => {
        failures.push(error.message);
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(agent.runAgent()).rejects.toThrow("filter broke");
    } finally {
      errorSpy.mockRestore();
    }

    expect(failures).toEqual(["filter broke"]);
    expect(agent.isRunning).toBe(false);
  });
});
