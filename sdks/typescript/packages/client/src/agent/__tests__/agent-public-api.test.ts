import { describe, it, expect, expectTypeOf, vi, afterEach } from "vitest";
import { lastValueFrom, Observable, of, toArray, type Subscriber } from "rxjs";
import {
  EventType,
  type BaseEvent,
  type Interrupt,
  type Message,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
} from "@ag-ui/core";
import { AbstractAgent } from "@/agent/agent";
import { HttpAgent } from "@/agent/http";
import type { Agent, AgentConfig } from "@/agent/types";
import type { AgentSubscriber } from "@/agent/subscriber";
import { defaultApplyEvents } from "@/apply/default";
import { Middleware, type MiddlewareNext } from "@/middleware/middleware";
import {
  BackwardCompatibility_0_0_39,
  BackwardCompatibility_0_0_45,
  BackwardCompatibility_0_0_57,
} from "@/middleware";

const THREAD_ID = "thread-1";
const RUN_ID = "run-1";

const runStarted: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: THREAD_ID,
  runId: RUN_ID,
};
const runFinished: RunFinishedEvent = {
  type: EventType.RUN_FINISHED,
  threadId: THREAD_ID,
  runId: RUN_ID,
};

function textMessageEvents(messageId: string, text: string) {
  const start: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
  };
  const content: TextMessageContentEvent = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: text,
  };
  const end: TextMessageEndEvent = { type: EventType.TEXT_MESSAGE_END, messageId };
  return [start, content, end];
}

function createInput(): RunAgentInput {
  return {
    threadId: THREAD_ID,
    runId: RUN_ID,
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

/** Emits a fixed list of events. Has no `connect` override. */
class ScriptedAgent extends AbstractAgent {
  constructor(
    private readonly events: BaseEvent[],
    config?: AgentConfig,
  ) {
    super({ threadId: THREAD_ID, ...config });
  }

  run(): Observable<BaseEvent> {
    return of(...this.events);
  }
}

/** Overrides `clone()` with a new instance, the pattern `copyStateTo` is for. */
class CopyingAgent extends ScriptedAgent {
  constructor(private readonly config: AgentConfig = {}) {
    super([runStarted, runFinished], config);
  }

  clone(): CopyingAgent {
    return this.copyStateTo(new CopyingAgent(this.config));
  }

  copyOnto(target: CopyingAgent) {
    return this.copyStateTo(target);
  }
}

/** Its constructor adds every backward-compatibility middleware. */
class OldPeerAgent extends ScriptedAgent {
  constructor() {
    super([runStarted, runFinished]);
  }

  get maxProtocolVersion() {
    return "0.0.39";
  }

  clone(): OldPeerAgent {
    return this.copyStateTo(new OldPeerAgent());
  }
}

/** Replays `events` from `connect`. */
class ConnectingAgent extends ScriptedAgent {
  constructor(
    private readonly connectEvents: BaseEvent[],
    config?: AgentConfig,
  ) {
    super([], config);
  }

  protected connect(): Observable<BaseEvent> {
    return of(...this.connectEvents);
  }
}

class ConnectAgentOverride extends ScriptedAgent {
  constructor() {
    super([]);
  }

  async connectAgent() {
    return { result: undefined, newMessages: [] };
  }
}

class ChildOfConnectingAgent extends ConnectingAgent {}

/** Opens a run that stays in flight until the test ends it. */
class ControlledAgent extends AbstractAgent {
  public open: Subscriber<BaseEvent>[] = [];

  run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.open.push(subscriber);
      subscriber.next(runStarted);
    });
  }
}

class CountingMiddleware extends Middleware {
  public calls = 0;

  run(input: RunAgentInput, next: MiddlewareNext): Observable<BaseEvent> {
    this.calls += 1;
    return this.runNext(input, next);
  }
}

const interrupt: Interrupt = { id: "interrupt-1", reason: "approval" };

function createSourceAgent() {
  const agent = new CopyingAgent({
    agentId: "agent-source",
    description: "source agent",
    threadId: "thread-source",
    initialMessages: [{ id: "msg-1", role: "user", content: "hello" }],
    initialState: { stage: "draft" },
  });
  agent.pendingInterrupts = [{ ...interrupt }];
  return agent;
}

/** Starts a run on a ControlledAgent and returns once its stream is open. */
async function startControlledRun() {
  const agent = new ControlledAgent();
  const run = agent.runAgent().then(
    () => "resolved",
    () => "rejected",
  );
  await vi.waitFor(() => expect(agent.open).toHaveLength(1));
  return { agent, run, stream: agent.open[0] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyStateTo", () => {
  it("copies the source values onto a target built with other values", () => {
    const source = createSourceAgent();

    const target = source.clone();

    expect(target).toBeInstanceOf(CopyingAgent);
    expect(target.agentId).toBe("agent-source");
    expect(target.description).toBe("source agent");
    expect(target.threadId).toBe("thread-source");
    expect(target.messages).toEqual([{ id: "msg-1", role: "user", content: "hello" }]);
    expect(target.state).toEqual({ stage: "draft" });
    expect(target.pendingInterrupts).toEqual([{ id: "interrupt-1", reason: "approval" }]);
  });

  it("deep-copies messages, state, and interrupts", () => {
    const source = createSourceAgent();
    const target = source.clone();

    target.messages[0].content = "changed";
    target.state.stage = "changed";
    target.pendingInterrupts[0].reason = "changed";

    expect(source.messages).toEqual([{ id: "msg-1", role: "user", content: "hello" }]);
    expect(source.state).toEqual({ stage: "draft" });
    expect(source.pendingInterrupts).toEqual([{ id: "interrupt-1", reason: "approval" }]);
  });

  it("gives the target its own subscriber list", () => {
    const source = createSourceAgent();
    const shared: AgentSubscriber = {};
    source.subscribe(shared);
    const target = source.clone();

    target.subscribe({});

    expect(target.subscribers).toHaveLength(2);
    expect(target.subscribers[0]).toBe(shared);
    expect(source.subscribers).toEqual([shared]);
  });

  it("runs a middleware added with use() before the copy on the target", async () => {
    const source = new CopyingAgent();
    const middleware = new CountingMiddleware();
    source.use(middleware);

    await source.clone().runAgent();

    expect(middleware.calls).toBe(1);
  });

  it("gives the target its own middleware list", async () => {
    const source = new CopyingAgent();
    const addedToTarget = new CountingMiddleware();

    source.clone().use(addedToTarget);
    await source.runAgent();

    expect(addedToTarget.calls).toBe(0);
  });

  it("replaces the middlewares that the target's constructor added", async () => {
    const compatibilityRuns = [
      vi.spyOn(BackwardCompatibility_0_0_39.prototype, "run"),
      vi.spyOn(BackwardCompatibility_0_0_45.prototype, "run"),
      vi.spyOn(BackwardCompatibility_0_0_57.prototype, "run"),
    ];

    await new OldPeerAgent().clone().runAgent();

    expect(compatibilityRuns.map((run) => run.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("returns the target", () => {
    const target = new CopyingAgent();

    expect(createSourceAgent().copyOnto(target)).toBe(target);
  });

  it("types a new-instance clone() override as the subclass", () => {
    expectTypeOf(new CopyingAgent().clone()).toEqualTypeOf<CopyingAgent>();
  });
});

describe("clone() types", () => {
  it("returns Agent when called through the Agent interface", () => {
    const agent: Agent = createSourceAgent();

    const cloned = agent.clone();

    expectTypeOf(cloned).toEqualTypeOf<Agent>();
    expect(cloned.threadId).toBe("thread-source");
  });

  it("returns HttpAgent for an HttpAgent", () => {
    expectTypeOf(new HttpAgent({ url: "https://example.com" }).clone()).toEqualTypeOf<HttpAgent>();
  });
});

describe("activeRunCompletion", () => {
  it("is undefined when no run is active", () => {
    expect(new ControlledAgent().activeRunCompletion).toBeUndefined();
  });

  it("is a promise while a run is in flight and undefined after it succeeds", async () => {
    const { agent, run, stream } = await startControlledRun();
    const completion = agent.activeRunCompletion;

    expect(completion).toBeInstanceOf(Promise);
    stream.next(runFinished);
    stream.complete();

    expect(await run).toBe("resolved");
    await expect(completion).resolves.toBeUndefined();
    expect(agent.activeRunCompletion).toBeUndefined();
  });

  it("is undefined after the stream errors, and the promise resolves", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { agent, run, stream } = await startControlledRun();
    const completion = agent.activeRunCompletion;

    stream.error(new Error("stream failed"));

    expect(await run).toBe("rejected");
    await expect(completion).resolves.toBeUndefined();
    expect(agent.activeRunCompletion).toBeUndefined();
  });

  it("is undefined after a RUN_ERROR event, and the promise resolves", async () => {
    const { agent, run, stream } = await startControlledRun();
    const completion = agent.activeRunCompletion;
    const runError: RunErrorEvent = { type: EventType.RUN_ERROR, message: "agent failed" };

    stream.next(runError);
    stream.complete();

    await run;
    await expect(completion).resolves.toBeUndefined();
    expect(agent.activeRunCompletion).toBeUndefined();
  });

  it("is undefined after detachActiveRun(), and the promise resolves", async () => {
    const { agent, run } = await startControlledRun();
    const completion = agent.activeRunCompletion;

    await agent.detachActiveRun();

    expect(await run).toBe("resolved");
    await expect(completion).resolves.toBeUndefined();
    expect(agent.activeRunCompletion).toBeUndefined();
  });
});

describe("supportsConnect()", () => {
  it("is false when neither connect nor connectAgent is overridden", () => {
    expect(new ScriptedAgent([]).supportsConnect()).toBe(false);
  });

  it("is true when connect is overridden", () => {
    expect(new ConnectingAgent([]).supportsConnect()).toBe(true);
  });

  it("is true when only a parent class overrides connect", () => {
    expect(new ChildOfConnectingAgent([]).supportsConnect()).toBe(true);
  });

  it("is true when only connectAgent is overridden", () => {
    expect(new ConnectAgentOverride().supportsConnect()).toBe(true);
  });
});

describe("connectAgent options", () => {
  /**
   * A replay that starts in the middle of a message: the agent already has
   * "Hel", and the stream sends the rest. Verification rejects it, because
   * no TEXT_MESSAGE_START opened the message in this stream.
   */
  function createReplayAgent() {
    const content: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "lo",
    };
    const end: TextMessageEndEvent = { type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" };
    const initialMessages: Message[] = [{ id: "msg-1", role: "assistant", content: "Hel" }];
    return new ConnectingAgent([runStarted, content, end, runFinished], { initialMessages });
  }

  it("applies a stream that verification rejects when verifyEvents is false", async () => {
    const agent = createReplayAgent();

    await agent.connectAgent(undefined, undefined, { verifyEvents: false });

    expect(agent.messages).toEqual([{ id: "msg-1", role: "assistant", content: "Hello" }]);
  });

  it("rejects the same stream without the option", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = createReplayAgent();
    const onRunFailed = vi.fn();

    await expect(agent.connectAgent(undefined, { onRunFailed })).rejects.toThrow(
      "No active text message found with ID 'msg-1'",
    );
    expect(onRunFailed).toHaveBeenCalledTimes(1);
  });

  it("still translates THINKING_* events when verifyEvents is false", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacyEvents = [
      { type: "THINKING_START" },
      { type: "THINKING_TEXT_MESSAGE_START" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "pondering" },
      { type: "THINKING_TEXT_MESSAGE_END" },
      { type: "THINKING_END" },
    ];
    // The retired THINKING_* types are not members of EventType any more.
    const retired = legacyEvents.map((event) => ({ ...event, type: event.type as EventType }));
    const agent = new ConnectingAgent([runStarted, ...retired, runFinished]);
    const seen: string[] = [];

    await agent.connectAgent(
      undefined,
      { onEvent: ({ event }) => void seen.push(event.type) },
      { verifyEvents: false },
    );

    expect(seen).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.RUN_FINISHED,
    ]);
  });
});

describe("defaultApplyEvents", () => {
  it("accepts an AbstractAgent and AgentSubscriber[] and passes the agent to subscribers", async () => {
    const agent: AbstractAgent = new ScriptedAgent([]);
    const agentsSeen: AbstractAgent[] = [];
    const subscribers: AgentSubscriber[] = [
      { onTextMessageStartEvent: (params) => void agentsSeen.push(params.agent) },
    ];
    const events$ = of(runStarted, ...textMessageEvents("msg-1", "hi"), runFinished);

    const mutations = await lastValueFrom(
      defaultApplyEvents(createInput(), events$, agent, subscribers).pipe(toArray()),
    );

    expect(mutations.at(-1)?.messages).toEqual([{ id: "msg-1", role: "assistant", content: "hi" }]);
    expect(agentsSeen).toHaveLength(1);
    expect(agentsSeen[0]).toBe(agent);
  });
});
