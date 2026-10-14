import { describe, it, expect, vi } from "vitest";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  Message,
} from "@ag-ui/client";
import { A2AMiddlewareAgent } from "./index";

class StubOrchestrationAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super();
  }

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      for (const event of this.events) {
        observer.next(event);
      }
      observer.complete();
    });
  }

  clone(): StubOrchestrationAgent {
    return new StubOrchestrationAgent(this.events);
  }
}

const TOOL_CALL_ID = "call-1";
const TOOL_NAME = "send_message_to_a2a_agent";

const orchestrationEvents = (): BaseEvent[] => [
  { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent,
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: TOOL_CALL_ID,
    toolCallName: TOOL_NAME,
  } as BaseEvent,
  { type: EventType.TOOL_CALL_END, toolCallId: TOOL_CALL_ID } as BaseEvent,
  { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
];

const assistantMessageWithArgs = (args: string): Message =>
  ({
    id: "msg-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: TOOL_NAME, arguments: args },
      },
    ],
  }) as Message;

const makeInput = (): RunAgentInput =>
  ({
    threadId: "t1",
    runId: "r1",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;

/**
 * Collects the events emitted by the middleware, resolving on terminal
 * completion or error. Rejects if the stream neither completes nor errors,
 * which is the "hang" symptom of issue #2444.
 */
const collect = (agent: A2AMiddlewareAgent, timeoutMs = 2000) =>
  new Promise<{ events: BaseEvent[]; error?: unknown; completed: boolean }>(
    (resolve, reject) => {
      const events: BaseEvent[] = [];
      const timer = setTimeout(
        () => reject(new Error("stream neither completed nor errored (hang)")),
        timeoutMs,
      );
      agent.run(makeInput()).subscribe({
        next: (event) => events.push(event),
        error: (error) => {
          clearTimeout(timer);
          resolve({ events, error, completed: false });
        },
        complete: () => {
          clearTimeout(timer);
          resolve({ events, completed: true });
        },
      });
    },
  );

describe("A2AMiddlewareAgent error handling (issue #2444)", () => {
  it("surfaces a RUN_ERROR when the pending tool call arguments are malformed JSON", async () => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs('{"agentName": "some-agent"')];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(new RegExp(TOOL_CALL_ID));
  });

  // Valid JSON is not the same thing as usable arguments. `JSON.parse("null")` succeeds, so the
  // parse guard lets it through and reading a field off the result throws where nothing is
  // catching yet: inside the synchronous `.map` callback, before `Promise.all` and its
  // `.catch(failRun)` exist. The stream then hangs rather than erroring.
  it.each([
    ["null", "null"],
    ["a bare number", "42"],
    ["a string", '"just a string"'],
    ["an array", "[]"],
  ])(
    "surfaces a RUN_ERROR when the tool call arguments parse to %s",
    async (_label, args) => {
      const agent = new A2AMiddlewareAgent({
        agentUrls: [],
        orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
      });
      agent.messages = [assistantMessageWithArgs(args)];

      const result = await collect(agent);

      const runError = result.events.find(
        (e) => e.type === EventType.RUN_ERROR,
      );
      expect(
        runError,
        "expected a RUN_ERROR event on the stream",
      ).toBeDefined();
      expect((runError as any).message).toMatch(new RegExp(TOOL_CALL_ID));
    },
  );

  // An object that parses cleanly can still be unusable. Without the agentName check these reach
  // the agent lookup as `undefined`, which fails with a message naming the wrong problem.
  it.each([
    ["is absent", "{}"],
    ["is not a string", '{"agentName": 123}'],
    ["is empty", '{"agentName": ""}'],
  ])("surfaces a RUN_ERROR when agentName %s", async (_label, args) => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs(args)];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/agentName/);
  });

  // The task becomes the message body and the sender takes a string. Reachable before this change
  // only because the parsed value was `any`.
  it.each([
    ["is absent", '{"agentName": "some-agent"}'],
    ["is not a string", '{"agentName": "some-agent", "task": {"a": 1}}'],
  ])("surfaces a RUN_ERROR when task %s", async (_label, args) => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [assistantMessageWithArgs(args)];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/task/);
  });

  it("surfaces a RUN_ERROR when the A2A call rejects", async () => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
    });
    agent.messages = [
      assistantMessageWithArgs(
        JSON.stringify({ agentName: "missing-agent", task: "hi" }),
      ),
    ];

    const result = await collect(agent);

    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect(runError, "expected a RUN_ERROR event on the stream").toBeDefined();
    expect((runError as any).message).toMatch(/missing-agent/);
  });
});

describe("delegated call arguments (PNI-549)", () => {
  /** An orchestrator whose stream counts its subscriptions. */
  class CountingOrchestrationAgent extends StubOrchestrationAgent {
    subscriptions = 0;
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((observer) => {
        this.subscriptions += 1;
        return super.run(input).subscribe(observer);
      });
    }
  }

  const streamedArgsEvents = (args: string): BaseEvent[] => [
    { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent,
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: TOOL_CALL_ID,
      toolCallName: TOOL_NAME,
    } as BaseEvent,
    // Split across two deltas, as streaming models send them.
    { type: EventType.TOOL_CALL_ARGS, toolCallId: TOOL_CALL_ID, delta: args.slice(0, 10) } as BaseEvent,
    { type: EventType.TOOL_CALL_ARGS, toolCallId: TOOL_CALL_ID, delta: args.slice(10) } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: TOOL_CALL_ID } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
  ];

  it("reads the arguments from the stream and runs the orchestrator once", async () => {
    const orchestrationAgent = new CountingOrchestrationAgent(
      streamedArgsEvents(JSON.stringify({ agentName: "missing-agent", task: "hi" })),
    );
    const agent = new A2AMiddlewareAgent({ agentUrls: [], orchestrationAgent });
    // No seeded messages: the arguments exist only in TOOL_CALL_ARGS.

    const result = await collect(agent);

    // Reaching the agent lookup means the streamed arguments were parsed.
    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect((runError as any)?.message).toMatch(/missing-agent/);
    expect(orchestrationAgent.subscriptions).toBe(1);
  });
});

describe("debug logging", () => {
  // agent.debug is a resolved config object, so a bare `if (this.debug)` was
  // always true and every delegated task and reply was logged.
  const runDelegation = async (debug?: boolean) => {
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      orchestrationAgent: new StubOrchestrationAgent(orchestrationEvents()),
      debug,
    });
    agent.messages = [
      assistantMessageWithArgs(JSON.stringify({ agentName: "missing-agent", task: "hi" })),
    ];
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await collect(agent);
      return spy.mock.calls.some(([message]) => message === "sending message to a2a agent");
    } finally {
      spy.mockRestore();
    }
  };

  it("stays quiet unless debug is enabled", async () => {
    expect(await runDelegation()).toBe(false);
  });

  it("logs delegations when debug is enabled", async () => {
    expect(await runDelegation(true)).toBe(true);
  });
});

describe("A2AMiddlewareAgent.clone", () => {
  // CopilotKit runs a clone per request; AbstractAgent.clone() alone drops the
  // middleware's own fields, and the clone's first run then fails reading the
  // agent cards.
  it("keeps the agent cards, instructions and orchestrator, so a clone runs", async () => {
    const orchestrationAgent = new StubOrchestrationAgent(orchestrationEvents());
    const agent = new A2AMiddlewareAgent({
      agentUrls: [],
      instructions: "Delegate to the departments.",
      orchestrationAgent,
    });

    const cloned = agent.clone();
    expect(cloned.instructions).toBe("Delegate to the departments.");
    expect(cloned.agentCards).toBe(agent.agentCards);
    expect(cloned.orchestrationAgent).not.toBe(orchestrationAgent);

    cloned.messages = [
      assistantMessageWithArgs(JSON.stringify({ agentName: "missing-agent", task: "hi" })),
    ];
    const result = await collect(cloned);

    // The run gets as far as resolving the delegated agent, which only
    // happens with the cards and the orchestrator in place.
    const runError = result.events.find((e) => e.type === EventType.RUN_ERROR);
    expect((runError as any)?.message).toMatch(/missing-agent/);
  });
});
