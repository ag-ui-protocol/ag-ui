/**
 * A producer-sent RUN_ERROR is reported, not raised.
 *
 * The stream is well formed — an agent honestly reporting that its run failed
 * is not a protocol violation — so the client accepts it: the reducer runs the
 * `onRunErrorEvent` subscribers, applies whatever they returned, and carries on.
 * `runAgent()` resolves. A following RUN_STARTED in the same stream begins a
 * new run, which `agent-run-error-restart.test.ts` pins end to end.
 *
 * The agent INSTANCE is likewise untouched: a new run on the same object starts
 * clean.
 *
 * A producer that also errors its stream after the RUN_ERROR (the shape the
 * Mastra and LangGraph adapters use) does fail the run, but only after every
 * event it sent first has been delivered to subscribers and applied.
 */
import { Observable, Subject, of } from "rxjs";
import { concatMap } from "rxjs/operators";
import { transformHttpEventStream } from "@/transform/http";
import { HttpEventType, type HttpEvent } from "@/run/http-request";
import { AbstractAgent } from "../agent";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";
import type { AgentStateMutation, AgentSubscriber } from "../subscriber";
import type { RunAgentResult } from "../agent";

/** Replays a different scripted stream on each successive run. */
class ScriptedAgent extends AbstractAgent {
  public runs = 0;
  constructor(private scripts: BaseEvent[][]) {
    super();
    this.debug = false;
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    const script = this.scripts[Math.min(this.runs, this.scripts.length - 1)];
    this.runs += 1;
    return of(...script);
  }
}

const started = (runId: string) =>
  ({ type: EventType.RUN_STARTED, threadId: "t", runId }) as RunStartedEvent;
const finished = (runId: string, result?: unknown) =>
  ({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId,
    ...(result !== undefined && { result }),
  }) as RunFinishedEvent;
const message = (id: string, delta: string): BaseEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta } as BaseEvent,
  { type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent,
];

/**
 * Runs `body` and reports what console.error saw.
 *
 * "Resolves" is only half of the contract; the other half is that it resolves
 * QUIETLY. agent.ts logs "Agent execution failed:" before rethrowing for every
 * failure it does not recognise as an abort, so that line is the observable
 * difference between a run the client carried to the end and a failure that
 * merely happened not to reject.
 */
async function loggedErrorsDuring(body: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const errors = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(" ")));
  try {
    await body();
  } finally {
    errors.mockRestore();
  }
  return lines.join("\n");
}

describe("a producer-sent RUN_ERROR", () => {
  it("reports the failure to onRunErrorEvent subscribers and resolves", async () => {
    const agent = new ScriptedAgent([
      [started("r1"), { type: EventType.RUN_ERROR, message: "boom" } as BaseEvent],
    ]);
    const seen: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen.push((event as { message?: string }).message ?? "");
      },
    } as AgentSubscriber);

    let result: RunAgentResult | undefined;
    const logged = await loggedErrorsDuring(async () => {
      result = await agent.runAgent({ runId: "r1" });
    });

    expect(seen).toEqual(["boom"]);
    expect(result).toBeDefined();
    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });

  it("keeps everything delivered before it, even when it arrives after RUN_FINISHED", async () => {
    // The verifier admits a late RUN_ERROR — a failure that surfaced after the
    // run reported success. Nothing already applied is rolled back.
    const agent = new ScriptedAgent([
      [
        started("r1"),
        ...message("m1", "delivered before the failure"),
        finished("r1", { answer: 42 }),
        { type: EventType.RUN_ERROR, message: "the transport failed while flushing" } as BaseEvent,
      ],
    ]);
    const seen: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen.push((event as { message?: string }).message ?? "");
      },
    } as AgentSubscriber);

    const result = await agent.runAgent({ runId: "r1" });

    expect(seen).toEqual(["the transport failed while flushing"]);
    expect(agent.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(result.result).toEqual({ answer: 42 });
  });

  it("still runs the subscribers when one of them stops the event's propagation", async () => {
    // stopPropagation keeps its ordinary meaning here — it stops LATER
    // subscribers, and nothing else. It is not an opt-out from a failure,
    // because a RUN_ERROR does not fail the run in the first place.
    const agent = new ScriptedAgent([
      [
        started("r1"),
        { type: EventType.RUN_ERROR, message: "handled by the app" } as BaseEvent,
      ],
    ]);
    let consulted = 0;
    agent.subscribe({
      onRunErrorEvent: () => {
        consulted += 1;
        return { stopPropagation: true };
      },
    } as AgentSubscriber);

    let result: RunAgentResult | undefined;
    const logged = await loggedErrorsDuring(async () => {
      result = await agent.runAgent({ runId: "r1" });
    });

    expect(consulted).toBe(1);
    expect(result?.newMessages).toEqual([]);
    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });

  it("leaves the agent usable: the next run on the same instance succeeds", async () => {
    const agent = new ScriptedAgent([
      [started("r1"), { type: EventType.RUN_ERROR, message: "first run failed" } as BaseEvent],
      [started("r2"), ...message("m2", "the second run works"), finished("r2", "ok")],
    ]);

    await agent.runAgent({ runId: "r1" });

    const second = await agent.runAgent({ runId: "r2" });
    expect(second.result).toBe("ok");
    expect(second.newMessages.map((m) => m.id)).toEqual(["m2"]);
    expect(agent.isRunning).toBe(false);
    expect(agent.pendingInterrupts).toEqual([]);
  });
});

describe("the abort contract", () => {
  it("resolves for a real AbortError coming up through the HTTP transform", async () => {
    // Not a hand-written event: this drives transform/http.ts itself, which is
    // where the abort -> `RUN_ERROR code: "abort"` + complete substitution
    // lives, and it is what makes abortRun() a graceful end rather than a
    // failure.
    class TransportAgent extends AbstractAgent {
      run(_input: RunAgentInput): Observable<BaseEvent> {
        const http = new Subject<HttpEvent>();
        const events$ = transformHttpEventStream(http);
        queueMicrotask(() => {
          http.next({
            type: HttpEventType.HEADERS,
            status: 200,
            headers: new Headers([["content-type", "text/event-stream"]]),
          });
          http.error(Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          }));
        });
        return events$;
      }
    }
    const agent = new TransportAgent();
    const seen: Array<Record<string, unknown>> = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen.push(event as unknown as Record<string, unknown>);
      },
    } as AgentSubscriber);

    const logged = await loggedErrorsDuring(() => agent.runAgent({ runId: "aborted" }));

    // Quietly, which is the whole contract: the synthesized RUN_ERROR reached
    // the reducer, carried the abort marker, and was NOT reported as a failure.
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe("abort");
    expect(seen[0].rawEvent).toBeInstanceOf(Error);
    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });

  it("resolves for the RUN_ERROR the transport synthesises on abort", async () => {
    // The same event, scripted, so the assertion does not depend on the
    // transport being wired up: `code: "abort"` and the abort error object as
    // `rawEvent` are what an aborted run puts on the stream.
    const agent = new ScriptedAgent([
      [
        started("r1"),
        {
          type: EventType.RUN_ERROR,
          message: "Request aborted",
          code: "abort",
          rawEvent: Object.assign(new Error("The operation was aborted."), {
            name: "AbortError",
          }),
        } as BaseEvent,
      ],
    ]);
    const logged = await loggedErrorsDuring(() => agent.runAgent({ runId: "r1" }));

    expect(logged).not.toContain("Agent execution failed");
    expect(agent.isRunning).toBe(false);
  });

  it("keeps the abort error object intact through enforcement", async () => {
    // `rawEvent` reaches the reducer as the same object the transport
    // attached: enforcement re-parses every event through the generated zod
    // schema, and `rawEvent` is `z.any()`, an opaque position the stripper and
    // the validator both pass through untouched. An application reading
    // `rawEvent` off an aborted run gets the abort error, not a copy of it.
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const agent = new ScriptedAgent([
      [
        started("r1"),
        {
          type: EventType.RUN_ERROR,
          message: "Request aborted",
          code: "abort",
          rawEvent: abortError,
        } as BaseEvent,
      ],
    ]);
    let seen: unknown;
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen = (event as { rawEvent?: unknown }).rawEvent;
      },
    } as AgentSubscriber);
    await agent.runAgent({ runId: "r1" });
    expect(seen).toBe(abortError);
    expect(seen instanceof Error).toBe(true);
  });
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends `events`, then errors the stream with `error`, all synchronously. */
function failingStream(events: BaseEvent[], error: Error): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    events.forEach((event) => subscriber.next(event));
    subscriber.error(error);
  });
}

class FailingStreamAgent extends AbstractAgent {
  constructor(
    private events: BaseEvent[],
    private error: Error,
  ) {
    super();
    this.debug = false;
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return failingStream(this.events, this.error);
  }
  protected connect(_input: RunAgentInput): Observable<BaseEvent> {
    return failingStream(this.events, this.error);
  }
}

/** Slow subscribers: each callback yields to a timer before returning. */
function slowRecorder() {
  const seen: string[] = [];
  const runErrors: BaseEvent[] = [];
  const subscriber = {
    onEvent: async ({ event }) => {
      await delay(10);
      seen.push(event.type);
    },
    onRunErrorEvent: async ({ event }) => {
      await delay(10);
      runErrors.push(event);
    },
    onRunFailed: vi.fn(),
    onRunFinalized: vi.fn(),
  } satisfies AgentSubscriber;
  return { seen, runErrors, subscriber };
}

describe("a stream that errors after sending events", () => {
  const runError = { type: EventType.RUN_ERROR, message: "model failed" } as BaseEvent;
  const failedRun = [started("r1"), ...message("m1", "partial answer"), runError];

  it.each(["runAgent", "connectAgent"] as const)(
    "%s delivers the RUN_ERROR and everything before it, then rejects with the stream's error",
    async (method) => {
      const error = new Error("stream failed after RUN_ERROR");
      const agent = new FailingStreamAgent(failedRun, error);
      const { seen, runErrors, subscriber } = slowRecorder();

      const logged = await loggedErrorsDuring(async () => {
        await expect(agent[method]({ runId: "r1" }, subscriber)).rejects.toBe(error);
      });

      expect(seen).toEqual([
        EventType.RUN_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.RUN_ERROR,
      ]);
      expect(runErrors).toEqual([runError]);
      expect(agent.messages).toEqual([{ id: "m1", role: "assistant", content: "partial answer" }]);
      expect(subscriber.onRunFailed).toHaveBeenCalledTimes(1);
      expect(subscriber.onRunFailed.mock.calls[0][0].error).toBe(error);
      await vi.waitFor(() => expect(subscriber.onRunFinalized).toHaveBeenCalledTimes(1));
      expect(agent.isRunning).toBe(false);
      expect(logged).toContain("Agent execution failed");
    },
  );

  it("applies every event before a plain stream error, with no RUN_ERROR", async () => {
    const error = new Error("connection dropped");
    const agent = new FailingStreamAgent([started("r1"), ...message("m1", "cut off")], error);
    const { seen, runErrors, subscriber } = slowRecorder();

    await loggedErrorsDuring(async () => {
      await expect(agent.runAgent({ runId: "r1" }, subscriber)).rejects.toBe(error);
    });

    expect(seen).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    expect(runErrors).toEqual([]);
    expect(agent.messages).toEqual([{ id: "m1", role: "assistant", content: "cut off" }]);
    expect(subscriber.onRunFailed).toHaveBeenCalledTimes(1);
    expect(agent.isRunning).toBe(false);
  });

  it("holds for a subclass that overrides apply", async () => {
    class SlowApplyAgent extends FailingStreamAgent {
      public applied: string[] = [];
      protected apply(
        input: RunAgentInput,
        events$: Observable<BaseEvent>,
        subscribers: AgentSubscriber[],
      ): Observable<AgentStateMutation> {
        const slowed$ = events$.pipe(
          concatMap(async (event) => {
            await delay(5);
            this.applied.push(event.type);
            return event;
          }),
        );
        return super.apply(input, slowed$, subscribers);
      }
    }
    const error = new Error("stream failed after RUN_ERROR");
    const agent = new SlowApplyAgent(failedRun, error);

    await loggedErrorsDuring(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toBe(error);
    });

    expect(agent.applied).toEqual(failedRun.map((event) => event.type));
    expect(agent.messages.map((m) => m.id)).toEqual(["m1"]);
  });
});
