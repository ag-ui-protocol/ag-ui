/**
 * A stream that ends without a terminal event must not be reported as success.
 *
 * `transports/index.mdx`: "A consumer whose stream ends without a terminal event
 * has a truncated run... A truncated run has no outcome. A consumer MUST NOT
 * synthesize a `RUN_FINISHED` for it and MUST NOT report it as having
 * succeeded... Whether and how to surface the truncation beyond that — leaving
 * the run unresolved, or raising a synthetic failure — is the consumer's
 * business." This client raises the synthetic failure.
 *
 * Every test here drives the WHOLE pipeline, the way
 * `agent-run-error-restart.test.ts` does: scripted frames go out through the
 * real SSE transform and come back through enforcement, chunk expansion,
 * verification, the reducer and the agent. A test that only asserted on
 * `verifyEvents` would say nothing about what `runAgent()` resolves with, which
 * is the whole of the defect.
 */
import { Observable, Subject } from "rxjs";
import { transformHttpEventStream } from "@/transform/http";
import { HttpEventType, type HttpEvent } from "@/run/http-request";
import { AbstractAgent } from "../agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import type { AgentSubscriber } from "../subscriber";
import type { RunAgentResult } from "../agent";

/** Replays scripted frames through the real SSE transport, as the wire does. */
class WireAgent extends AbstractAgent {
  constructor(
    private frames: unknown[],
    private onOpen?: (http: Subject<HttpEvent>) => void,
  ) {
    super({ threadId: "t" });
    this.debug = false;
  }
  private emit(): Observable<BaseEvent> {
    const http = new Subject<HttpEvent>();
    const events$ = transformHttpEventStream(http);
    queueMicrotask(() => {
      http.next({
        type: HttpEventType.HEADERS,
        status: 200,
        headers: new Headers([["content-type", "text/event-stream"]]),
      });
      for (const frame of this.frames) {
        http.next({
          type: HttpEventType.DATA,
          data: new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
        });
      }
      if (this.onOpen) this.onOpen(http);
      else http.complete();
    });
    return events$;
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    return this.emit();
  }
  /** The connect pipeline replays the same frames, to prove it has the same guard. */
  protected override connect(_input: RunAgentInput): Observable<BaseEvent> {
    return this.emit();
  }
}

/** What the run's lifecycle callbacks saw. */
interface Watched {
  failures: string[];
  finalized: number;
}

function watch(agent: AbstractAgent): Watched {
  const watched: Watched = { failures: [], finalized: 0 };
  agent.subscribe({
    onRunFailed: ({ error }) => {
      watched.failures.push(error instanceof Error ? error.message : String(error));
    },
    onRunFinalized: () => {
      watched.finalized++;
    },
  } as AgentSubscriber);
  return watched;
}

const started = (runId: string) => ({ type: EventType.RUN_STARTED, threadId: "t", runId });
const finished = (runId: string) => ({
  type: EventType.RUN_FINISHED,
  threadId: "t",
  runId,
  outcome: { type: "success" },
});
const message = (id: string, delta: string): unknown[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta },
  { type: EventType.TEXT_MESSAGE_END, messageId: id },
];

/** console.error is where agent.ts reports a failure it did not recognise. */
async function silencingErrors<T>(body: () => Promise<T>): Promise<T> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await body();
  } finally {
    errors.mockRestore();
  }
}

/**
 * An agent whose abortRun() cuts the wire: the transport completes without a
 * terminal event, exactly as a cancelled in-process stream does (mastra #2288).
 * Overrides call super.abortRun(), as the base class requires.
 */
class AbortableWireAgent extends WireAgent {
  private http?: Subject<HttpEvent>;
  constructor(frames: unknown[]) {
    super(frames, (http) => {
      this.http = http; // hold the stream open until the consumer aborts
    });
  }
  override abortRun(): void {
    this.http?.complete();
    super.abortRun();
  }
}

describe("a stream the consumer cut short", () => {
  it("settles runAgent() by resolving after abortRun(), not with the truncation failure", async () => {
    const agent = new AbortableWireAgent([started("r1"), ...message("m1", "half an answer")]);
    const watched = watch(agent);
    const firstMessage = new Promise<void>((resolve) => {
      agent.subscribe({ onTextMessageEndEvent: () => resolve() } as AgentSubscriber);
    });

    const finished = agent.runAgent({ runId: "r1" });
    await firstMessage;
    agent.abortRun();

    // The consumer's own stop is not a truncated producer: the promise settles
    // the way it always has (#2288), the failure callback stays quiet, and what
    // arrived before the abort is kept.
    await expect(finished).resolves.toBeDefined();
    expect(watched.failures).toHaveLength(0);
    expect(watched.finalized).toBe(1);
    expect(agent.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(agent.isRunning).toBe(false);
  });

  it("does not let one aborted run excuse the next run's truncation", async () => {
    const agent = new AbortableWireAgent([started("r1"), ...message("m1", "first")]);
    const firstMessage = new Promise<void>((resolve) => {
      agent.subscribe({ onTextMessageEndEvent: () => resolve() } as AgentSubscriber);
    });
    const first = agent.runAgent({ runId: "r1" });
    await firstMessage;
    agent.abortRun();
    await first;

    // Second run on the same agent: the wire is cut by the producer this time.
    const truncated = new WireAgent([started("r2"), ...message("m2", "second")]);
    await silencingErrors(async () => {
      await expect(truncated.runAgent({ runId: "r2" })).rejects.toThrow(
        /ended without a terminal event/,
      );
    });
  });
});

describe("a stream that ends without a terminal event", () => {
  it("fails the run rather than resolving it, when a run was left open", async () => {
    const agent = new WireAgent([started("r1"), ...message("m1", "half an answer")]);
    const watched = watch(agent);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(
        /ended without a terminal event/,
      );
    });

    // The failure reached the subscriber, and the run was still finalized.
    expect(watched.failures).toHaveLength(1);
    expect(watched.failures[0]).toContain("r1");
    expect(watched.finalized).toBe(1);
    // Everything the run delivered before the break stays delivered: the spec
    // forbids reporting success, not keeping what arrived.
    expect(agent.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(agent.isRunning).toBe(false);
  });

  it("fails the run for a stream that carried no events at all", async () => {
    const agent = new WireAgent([]);
    const watched = watch(agent);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(
        /ended without a terminal event/,
      );
    });

    expect(watched.failures).toHaveLength(1);
    expect(watched.finalized).toBe(1);
    expect(agent.isRunning).toBe(false);
  });

  it("fails a SECOND run left open after a first one closed", async () => {
    // The check is about the last run on the stream, not about whether any run
    // ever finished: a `sawTerminal` flag alone would wave this through.
    const agent = new WireAgent([
      started("r1"),
      ...message("m1", "first run"),
      finished("r1"),
      started("r2"),
      ...message("m2", "second run, cut short"),
    ]);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(/run 'r2' is still open/);
    });

    expect(agent.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("fails a truncated connected stream too", async () => {
    const agent = new WireAgent([started("r1"), ...message("m1", "half an answer")]);
    const watched = watch(agent);

    await silencingErrors(async () => {
      await expect(agent.connectAgent({ runId: "r1" })).rejects.toThrow(
        /ended without a terminal event/,
      );
    });

    expect(watched.failures).toHaveLength(1);
    expect(watched.finalized).toBe(1);
  });
});

describe("what the truncation check must NOT touch", () => {
  it("resolves for a stream that ends cleanly with RUN_FINISHED", async () => {
    const agent = new WireAgent([started("r1"), ...message("m1", "done"), finished("r1")]);
    const watched = watch(agent);

    const result: RunAgentResult = await agent.runAgent({ runId: "r1" });

    expect(result.newMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(watched.failures).toEqual([]);
    expect(watched.finalized).toBe(1);
  });

  it("resolves for a stream that ends with RUN_ERROR", async () => {
    // RUN_ERROR IS a terminal event: the producer reported its own failure, the
    // run is closed, and nothing was truncated.
    const agent = new WireAgent([
      started("r1"),
      ...message("m1", "before the failure"),
      { type: EventType.RUN_ERROR, message: "the tool host was unreachable" },
    ]);
    const watched = watch(agent);

    const result: RunAgentResult = await agent.runAgent({ runId: "r1" });

    expect(result.newMessages.map((m) => m.id)).toEqual(["m1"]);
    expect(watched.failures).toEqual([]);
  });

  it("leaves a DETACHED run exactly as it was: no failure, no rejection", async () => {
    // Detaching tears the pipeline down by unsubscription, which is not a
    // completion — the truncation check must never see it. A run detached
    // mid-stream is a deliberate stop, not a broken connection.
    let openHttp: Subject<HttpEvent> | undefined;
    const agent = new WireAgent([started("r1"), ...message("m1", "still going")], (http) => {
      openHttp = http;
    });
    const watched = watch(agent);

    const run = agent.runAgent({ runId: "r1" });
    // Let the scripted frames land before detaching.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await agent.detachActiveRun();

    await expect(run).resolves.toBeDefined();
    expect(watched.failures).toEqual([]);
    expect(agent.isRunning).toBe(false);
    openHttp?.complete();
  });
});
