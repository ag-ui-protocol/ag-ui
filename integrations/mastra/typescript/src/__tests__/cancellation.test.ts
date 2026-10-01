import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { RunFinishedEventSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { FakeMemory, makeInput, collectEvents } from "./helpers";
import { MastraAgent } from "../mastra";

// ---------------------------------------------------------------------------
// Regression tests for #2288: unsubscribing from the run() Observable must
// propagate cancellation into the underlying Mastra stream. Before the fix the
// teardown was `() => {}`, so an aborted run kept pulling (and billing) tokens
// to completion.
//
// Two separate mechanisms are covered, and they are NOT equivalent:
//
//   LOCAL  (@mastra/core Agent) — the AbortController's signal is handed to
//          `agent.stream()`/`agent.resumeStream()`, so @mastra/core itself
//          stops generating and emits a first-class `abort` chunk.
//
//   REMOTE (@mastra/client-js Agent) — `abortSignal` is deliberately NOT sent.
//          client-js Omits it from its stream params and reads the fetch signal
//          from construction-time `ClientOptions.abortSignal`, so a per-call
//          value would only be JSON-serialized into the POST body. All we can
//          do is short-circuit our own consumption loop. Server-side billing is
//          NOT stopped, and the tests below assert exactly that much and no
//          more.
//
// Each fake hands out a gate the test opens only AFTER unsubscribing, so the
// stream is provably still mid-flight when teardown fires.
// ---------------------------------------------------------------------------

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const RESUME_INPUT = makeInput({
  messages: [{ id: "1", role: "user", content: "Hi" }] as any,
  resume: [
    {
      interruptId: "mastra-run-1::call-1",
      status: "resolved",
      payload: { approved: true },
    },
  ],
});

const STREAM_INPUT = makeInput({
  messages: [{ id: "1", role: "user", content: "Hi" }] as any,
});

/** Subscribes, waits for the first event, unsubscribes, then opens the gate. */
async function runUntilFirstEventThenUnsubscribe(
  agent: MastraAgent,
  input = STREAM_INPUT,
  gate?: { release: () => void },
) {
  const events: BaseEvent[] = [];
  const firstChunk = deferred();

  const subscription = agent.run(input).subscribe({
    next: (event) => {
      events.push(event);
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
    },
    error: () => firstChunk.release(),
    complete: () => firstChunk.release(),
  });

  await firstChunk.promise;
  subscription.unsubscribe();
  const countAtUnsubscribe = events.length;

  gate?.release();
  await tick();

  return { events, countAtUnsubscribe };
}

/**
 * A fullStream that yields one chunk, waits on `gate`, then yields MANY more.
 * `pulled` counts how many chunks the consumer actually pulled, which is how
 * the "stop consuming" assertions are made.
 */
function countingStream(gate: Promise<void>, after = 10) {
  const state = { pulled: 0 };
  const stream = (async function* () {
    state.pulled++;
    yield { type: "text-delta", payload: { text: "first" } };
    await gate;
    for (let i = 0; i < after; i++) {
      state.pulled++;
      yield { type: "text-delta", payload: { text: `more-${i}` } };
    }
    state.pulled++;
    yield { type: "finish", payload: {} };
  })();
  return { stream, state };
}

function makeCountingProcessDataStream(gate: Promise<void>, after = 10) {
  const state = { delivered: 0, handled: 0 };
  const processDataStream = async ({
    onChunk,
  }: {
    onChunk: (chunk: any) => Promise<void>;
  }) => {
    state.delivered++;
    await onChunk({ type: "text-delta", payload: { text: "first" } });
    await gate;
    for (let i = 0; i < after; i++) {
      state.delivered++;
      await onChunk({ type: "text-delta", payload: { text: `more-${i}` } });
    }
    state.delivered++;
    await onChunk({ type: "finish", payload: {} });
  };
  return { processDataStream, state };
}

function localFake(overrides: Record<string, any>) {
  return {
    memory: new FakeMemory(),
    async getMemory() {
      return (this as any).memory;
    },
    async listTools() {
      return {};
    },
    ...overrides,
  };
}

/**
 * Counts how many chunks actually reach the chunk processor. For the remote
 * (callback-driven) paths this is the only observable signal that we stopped
 * consuming: the producer keeps calling us back, and post-unsubscribe AG-UI
 * events are swallowed by the closed subscriber either way.
 */
function countHandledChunks(agent: MastraAgent) {
  const state = { handled: 0 };
  const original = (agent as any).createChunkProcessor.bind(agent);
  vi.spyOn(agent as any, "createChunkProcessor").mockImplementation(
    (...args: any[]) => {
      const { handleChunk, flush } = original(...args);
      return {
        flush,
        handleChunk: (chunk: any) => {
          state.handled++;
          return handleChunk(chunk);
        },
      };
    },
  );
  return state;
}

function wrap(fakeAgent: any) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run() cancellation propagation (#2288)", () => {
  describe("local agent stream()", () => {
    it("aborts the signal forwarded to agent.stream() when unsubscribed", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap(
        localFake({
          async stream(_messages: any, opts: any) {
            capturedOpts = opts;
            return { fullStream: stream };
          },
        }),
      );

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      expect(capturedOpts?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(capturedOpts.abortSignal.aborted).toBe(true);
      // Abandoned, not cancelled: nothing more is sent, RUN_FINISHED included.
      expect(events).toHaveLength(countAtUnsubscribe);
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
    });

    it("stops pulling from fullStream once cancelled", async () => {
      const gate = deferred();
      const { stream, state } = countingStream(gate.promise, 10);

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      // 1 chunk before the gate + at most 1 more pulled by the `for await`
      // before the abort check runs. Without the check the generator drains all
      // 12.
      expect(state.pulled).toBeLessThanOrEqual(2);
    });
  });

  describe("remote agent stream()", () => {
    it("does NOT send abortSignal to the remote agent (client-js ignores it)", async () => {
      const gate = deferred();
      const { processDataStream } = makeCountingProcessDataStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap({
        async stream(_messages: any, opts: any) {
          capturedOpts = opts;
          return { processDataStream };
        },
      });

      await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      // @mastra/client-js Omits `abortSignal` from StreamParamsBase and would
      // JSON-serialize it into the request body as `{}`. Sending it is worse
      // than useless, so the bridge must not.
      expect(capturedOpts).not.toBeNull();
      expect("abortSignal" in capturedOpts).toBe(false);
    });

    it("stops consuming the remote data stream once cancelled", async () => {
      const gate = deferred();
      const { processDataStream, state } = makeCountingProcessDataStream(
        gate.promise,
        10,
      );

      const agent = wrap({
        async stream() {
          return { processDataStream };
        },
      });
      const handled = countHandledChunks(agent);

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, STREAM_INPUT, gate);

      // The callback-driven remote stream keeps delivering (we cannot stop the
      // producer over client-js), but every post-abort chunk must be dropped
      // before it reaches the chunk processor.
      expect(state.delivered).toBe(12);
      expect(handled.handled).toBe(1);
      expect(events).toHaveLength(countAtUnsubscribe);
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK),
      ).toHaveLength(1);
    });
  });

  describe("local agent resumeStream()", () => {
    it("aborts the signal forwarded via resume options when unsubscribed", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: (async function* () {})() };
          },
          async resumeStream(_resumeData: any, opts: any) {
            capturedOpts = opts;
            return { fullStream: stream };
          },
        }),
      );

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, RESUME_INPUT, gate);

      expect(capturedOpts?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(capturedOpts.abortSignal.aborted).toBe(true);
      expect(events).toHaveLength(countAtUnsubscribe);
    });
  });

  describe("remote agent resumeStream()", () => {
    it("does NOT send abortSignal, and stops consuming when cancelled", async () => {
      const gate = deferred();
      const { processDataStream, state } = makeCountingProcessDataStream(
        gate.promise,
        10,
      );
      let capturedOpts: any = null;

      const agent = wrap({
        async stream() {
          return { processDataStream: async () => {} };
        },
        async resumeStream(_resumeData: any, opts: any) {
          capturedOpts = opts;
          return { processDataStream };
        },
      });
      const handled = countHandledChunks(agent);

      const { events, countAtUnsubscribe } =
        await runUntilFirstEventThenUnsubscribe(agent, RESUME_INPUT, gate);

      expect(capturedOpts).not.toBeNull();
      expect("abortSignal" in capturedOpts).toBe(false);
      expect(state.delivered).toBe(12);
      expect(handled.handled).toBe(1);
      expect(events).toHaveLength(countAtUnsubscribe);
    });
  });

  describe("abort chunks", () => {
    it("ends the run as cancelled on @mastra/core's `abort` chunk, without warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agent = wrap(
        localFake({
          async stream() {
            return {
              fullStream: (async function* () {
                yield { type: "text-delta", payload: { text: "partial" } };
                // Shape emitted by @mastra/core when a run is cancelled.
                yield {
                  type: "abort",
                  runId: "r1",
                  from: "AGENT",
                  payload: {},
                };
              })(),
            };
          },
        }),
      );

      const events = await collectEvents(agent, STREAM_INPUT);

      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("Unrecognized stream chunk type"),
        ),
      ).toBe(false);
      // Mastra stopped the run under us (its signal is not this run's): the
      // stream ends, the partial text stays delivered, and the run reports
      // that it was stopped rather than completed.
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).length,
      ).toBeGreaterThan(0);
      const finished = events[events.length - 1] as any;
      expect(finished.type).toBe(EventType.RUN_FINISHED);
      expect(finished.outcome).toEqual({ type: "cancelled" });
    });
  });

  describe("overlapping runs", () => {
    it("isolates teardown per run and abortRun() reaches every in-flight run", async () => {
      const gates = [deferred(), deferred(), deferred()];
      const signals: AbortSignal[] = [];

      const agent = wrap(
        localFake({
          async stream(_messages: any, opts: any) {
            const gate = gates[signals.length];
            signals.push(opts.abortSignal);
            return { fullStream: countingStream(gate.promise).stream };
          },
        }),
      );

      /** Subscribes and resolves once the run is actually streaming. */
      const start = async () => {
        const first = deferred();
        const sub = agent.run(STREAM_INPUT).subscribe({
          next: (e) => {
            if (e.type === EventType.TEXT_MESSAGE_CHUNK) first.release();
          },
          error: () => first.release(),
          complete: () => first.release(),
        });
        await first.promise;
        return sub;
      };

      const subA = await start();
      const subB = await start();
      expect(signals).toHaveLength(2);

      // Tearing down the OLDER run must abort only its own controller.
      subA.unsubscribe();
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      // ...and must retire it, so the set only tracks what is still live.
      expect((agent as any).abortControllers.size).toBe(1);

      const subC = await start();
      expect(signals).toHaveLength(3);
      expect((agent as any).abortControllers.size).toBe(2);

      // abortRun() must reach BOTH still-live runs, not just the newest. With
      // a single instance-level controller field, starting C would have
      // orphaned B and left it generating.
      agent.abortRun();
      expect(signals[1].aborted).toBe(true);
      expect(signals[2].aborted).toBe(true);

      gates.forEach((g) => g.release());
      subB.unsubscribe();
      subC.unsubscribe();
      await tick();
      expect((agent as any).abortControllers.size).toBe(0);
    });
  });

  describe("abortRun()", () => {
    it("aborts the in-flight run's signal", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);
      let capturedOpts: any = null;

      const agent = wrap(
        localFake({
          async stream(_messages: any, opts: any) {
            capturedOpts = opts;
            return { fullStream: stream };
          },
        }),
      );

      const firstChunk = deferred();
      const subscription = agent.run(STREAM_INPUT).subscribe({
        next: (event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
        },
        error: () => firstChunk.release(),
        complete: () => firstChunk.release(),
      });

      await firstChunk.promise;
      agent.abortRun();

      expect(capturedOpts?.abortSignal?.aborted).toBe(true);

      gate.release();
      subscription.unsubscribe();
      await tick();
    });

    // abortRun() has no subscription to close, so it has to settle the
    // Observable itself. These assert that without the second unsubscribe the
    // tests above lean on: a caller that only calls abortRun() must not be
    // left waiting on a run that never ends.
    it("settles the run() Observable on its own, with no unsubscribe", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      const firstChunk = deferred();
      const settled = deferred();
      let outcome: "complete" | "error" | null = null;

      agent.run(STREAM_INPUT).subscribe({
        next: (event) => {
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
        },
        error: () => {
          outcome = "error";
          settled.release();
        },
        complete: () => {
          outcome = "complete";
          settled.release();
        },
      });

      await firstChunk.promise;
      agent.abortRun();

      await Promise.race([
        settled.promise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("run() never settled")), 1000),
        ),
      ]);

      expect(outcome).toBe("complete");
    });

    it("settles runAgent() on its own, with no unsubscribe", async () => {
      const gate = deferred();
      const { stream } = countingStream(gate.promise);

      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      const firstChunk = deferred();
      const finished = agent.runAgent(
        { forwardedProps: {} },
        {
          onTextMessageContentEvent: () => {
            firstChunk.release();
          },
        },
      );

      await firstChunk.promise;
      agent.abortRun();

      await expect(
        Promise.race([
          finished,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("runAgent() never settled")),
              1000,
            ),
          ),
        ]),
      ).resolves.toBeDefined();
    });

    it("does not report a stream that rejects after abortRun() as a failure", async () => {
      const gate = deferred();
      const stream = (async function* () {
        yield { type: "text-delta", payload: { text: "first" } };
        await gate.promise;
        throw new Error("The operation was aborted");
      })();
      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: stream };
          },
        }),
      );

      const events: BaseEvent[] = [];
      const firstChunk = deferred();
      const settled = deferred();
      let outcome: "complete" | "error" | null = null;
      agent.run(STREAM_INPUT).subscribe({
        next: (event) => {
          events.push(event);
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) firstChunk.release();
        },
        error: () => {
          outcome = "error";
          settled.release();
        },
        complete: () => {
          outcome = "complete";
          settled.release();
        },
      });

      await firstChunk.promise;
      agent.abortRun();
      gate.release();
      await settled.promise;
      await tick();

      expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    });
  });

  describe("a stopped run ends with the cancelled outcome", () => {
    const FRONTEND_TOOL = {
      name: "show_chart",
      description: "Render a chart",
      parameters: { type: "object", properties: {} },
    };
    const INPUT_WITH_TOOL = makeInput({
      messages: [{ id: "1", role: "user", content: "Hi" }] as any,
      tools: [FRONTEND_TOOL],
    });
    const RESUME_WITH_TOOL = { ...RESUME_INPUT, tools: [FRONTEND_TOOL] };

    // Chunks that leave something open, then wait on `gate`.
    const OPEN_REASONING = [
      { type: "reasoning-start", payload: { id: "r1" } },
      { type: "reasoning-delta", payload: { id: "r1", text: "thinking" } },
    ];
    const OPEN_TOOL_CALL = [
      {
        type: "tool-call-input-streaming-start",
        payload: { toolCallId: "tc-ui", toolName: "show_chart" },
      },
      {
        type: "tool-call-delta",
        payload: { toolCallId: "tc-ui", argsTextDelta: '{"kind":' },
      },
    ];

    function localStream(chunks: any[], gate: Promise<void>) {
      return (async function* () {
        yield* chunks;
        await gate;
        yield { type: "finish", payload: {} };
      })();
    }

    function remoteStream(chunks: any[], gate: Promise<void>) {
      return async ({ onChunk }: { onChunk: (c: any) => Promise<void> }) => {
        for (const chunk of chunks) await onChunk(chunk);
        await gate;
        await onChunk({ type: "finish", payload: {} });
      };
    }

    /** Runs until `trigger` is emitted, calls abortRun(), and settles. */
    async function abortOn(
      agent: MastraAgent,
      trigger: EventType,
      input = INPUT_WITH_TOOL,
    ) {
      const events: BaseEvent[] = [];
      const reached = deferred();
      let outcome: "complete" | "error" | null = null;
      const settled = new Promise<void>((resolve) => {
        agent.run(input).subscribe({
          next: (event) => {
            events.push(event);
            if (event.type === trigger) reached.release();
          },
          error: () => {
            outcome = "error";
            resolve();
          },
          complete: () => {
            outcome = "complete";
            resolve();
          },
        });
      });
      await reached.promise;
      agent.abortRun();
      await settled;
      return { events, outcome: outcome as "complete" | "error" | null };
    }

    function expectCancelledEnding(events: BaseEvent[], closing: EventType[]) {
      expect(events.slice(-(closing.length + 1)).map((e) => e.type)).toEqual([
        ...closing,
        EventType.RUN_FINISHED,
      ]);
      const finished = events[events.length - 1] as any;
      expect(finished.outcome).toEqual({ type: "cancelled" });
      expect(finished.result).toBeUndefined();
      expect(() => RunFinishedEventSchema.parse(finished)).not.toThrow();
      expect(
        events.filter((e) => e.type === EventType.RUN_FINISHED),
      ).toHaveLength(1);
    }

    const CLOSES_REASONING = [
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
    ];

    it("closes an open reasoning message, then sends RUN_FINISHED cancelled", async () => {
      const gate = deferred();
      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: localStream(OPEN_REASONING, gate.promise) };
          },
        }),
      );

      const { events, outcome } = await abortOn(
        agent,
        EventType.REASONING_MESSAGE_CONTENT,
      );
      gate.release();
      await tick();

      expect(outcome).toBe("complete");
      expectCancelledEnding(events, CLOSES_REASONING);
    });

    it("closes an open tool call, then sends RUN_FINISHED cancelled", async () => {
      const gate = deferred();
      const agent = wrap(
        localFake({
          async stream() {
            return { fullStream: localStream(OPEN_TOOL_CALL, gate.promise) };
          },
        }),
      );

      const { events } = await abortOn(agent, EventType.TOOL_CALL_ARGS);
      gate.release();
      await tick();

      expectCancelledEnding(events, [EventType.TOOL_CALL_END]);
      // A cancelled run names no pending calls: it waits for nothing.
      expect((events[events.length - 1] as any).outcome).toEqual({
        type: "cancelled",
      });
    });

    it("does the same for a remote run", async () => {
      const gate = deferred();
      const agent = wrap({
        async stream() {
          return {
            processDataStream: remoteStream(OPEN_REASONING, gate.promise),
          };
        },
      });

      const { events, outcome } = await abortOn(
        agent,
        EventType.REASONING_MESSAGE_CONTENT,
      );
      gate.release();
      await tick();

      expect(outcome).toBe("complete");
      expectCancelledEnding(events, CLOSES_REASONING);
    });

    it("does the same for a local resume", async () => {
      const gate = deferred();
      const agent = wrap(
        localFake({
          async resumeStream() {
            return { fullStream: localStream(OPEN_REASONING, gate.promise) };
          },
        }),
      );

      const { events } = await abortOn(
        agent,
        EventType.REASONING_MESSAGE_CONTENT,
        RESUME_WITH_TOOL,
      );
      gate.release();
      await tick();

      expectCancelledEnding(events, CLOSES_REASONING);
    });

    it("does the same for a remote resume", async () => {
      const gate = deferred();
      const agent = wrap({
        async stream() {
          return { processDataStream: async () => {} };
        },
        async resumeStream() {
          return {
            processDataStream: remoteStream(OPEN_REASONING, gate.promise),
          };
        },
      });

      const { events } = await abortOn(
        agent,
        EventType.REASONING_MESSAGE_CONTENT,
        RESUME_WITH_TOOL,
      );
      gate.release();
      await tick();

      expectCancelledEnding(events, CLOSES_REASONING);
    });

    it("reaches the client as a cancelled run the verifier accepts", async () => {
      const gate = deferred();
      const agent = wrap(
        localFake({
          async stream() {
            return {
              fullStream: localStream(
                [...OPEN_REASONING, ...OPEN_TOOL_CALL],
                gate.promise,
              ),
            };
          },
        }),
      );

      const streaming = deferred();
      let seen: string | undefined;
      const finished = agent.runAgent(
        { tools: [FRONTEND_TOOL] },
        {
          onToolCallArgsEvent: () => {
            streaming.release();
          },
          onRunFinishedEvent: ({ outcome }) => {
            seen = outcome;
          },
        },
      );

      await streaming.promise;
      agent.abortRun();
      await expect(finished).resolves.toBeDefined();
      gate.release();

      expect(seen).toBe("cancelled");
      expect(agent.messages.find((m) => m.role === "reasoning")).toMatchObject({
        content: "thinking",
      });
    });

    it("ends a run that is stopped before its stream opens", async () => {
      const opened = deferred();
      const agent = wrap(
        localFake({
          async stream() {
            opened.release();
            // Never resolves: the run is stopped while Mastra is starting.
            return new Promise(() => {});
          },
        }),
      );

      const events: BaseEvent[] = [];
      const settled = new Promise<void>((resolve) => {
        agent
          .run(STREAM_INPUT)
          .subscribe({ next: (e) => events.push(e), complete: resolve });
      });
      await opened.promise;
      agent.abortRun();
      await settled;

      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
      ]);
      expect((events[1] as any).outcome).toEqual({ type: "cancelled" });
    });
  });

  // A stop that lands after the stream has drained, while the run reads its
  // working-memory snapshot, is too late to cancel anything: the run keeps
  // the ending it already reached.
  describe("a stop after the stream drained keeps the run's real outcome", () => {
    const SUSPEND = {
      type: "tool-call-suspended",
      payload: {
        toolCallId: "tc-approve",
        toolName: "approve",
        suspendPayload: {},
        args: {},
        resumeSchema: "{}",
      },
    };
    const FRONTEND_CALL = [
      {
        type: "tool-call-input-streaming-start",
        payload: { toolCallId: "tc-ui", toolName: "show_chart" },
      },
      {
        type: "tool-call-delta",
        payload: { toolCallId: "tc-ui", argsTextDelta: "{}" },
      },
      {
        type: "tool-call-input-streaming-end",
        payload: { toolCallId: "tc-ui" },
      },
      {
        type: "tool-call",
        payload: { toolCallId: "tc-ui", toolName: "show_chart", args: {} },
      },
    ];

    /** Streams `chunks`, then calls abortRun() inside the snapshot read. */
    async function abortDuringSnapshot(chunks: any[], input = STREAM_INPUT) {
      let drained = false;
      const memory = new FakeMemory();
      const agent = wrap(
        localFake({
          memory,
          async stream() {
            return {
              fullStream: (async function* () {
                yield* chunks;
                yield { type: "finish", payload: {} };
                drained = true;
              })(),
            };
          },
        }),
      );
      memory.getWorkingMemory = async () => {
        if (drained) {
          agent.abortRun();
          await tick();
        }
        return JSON.stringify({ step: 1 });
      };

      const events: BaseEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        agent.run(input).subscribe({
          next: (e) => events.push(e),
          error: reject,
          complete: resolve,
        });
      });
      await tick();

      const finished = events.filter((e) => e.type === EventType.RUN_FINISHED);
      expect(finished).toHaveLength(1);
      expect(events[events.length - 1]).toBe(finished[0]);
      expect(() => RunFinishedEventSchema.parse(finished[0])).not.toThrow();
      return finished[0] as any;
    }

    it("an interrupted run still reports its interrupt", async () => {
      const finished = await abortDuringSnapshot([SUSPEND]);

      expect(finished.outcome?.type).toBe("interrupt");
      expect(finished.outcome.interrupts).toHaveLength(1);
      expect(finished.outcome.interrupts[0]).toMatchObject({
        toolCallId: "tc-approve",
      });
    });

    it("a run that stopped on a frontend call still names it", async () => {
      const finished = await abortDuringSnapshot(
        FRONTEND_CALL,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }] as any,
          tools: [
            {
              name: "show_chart",
              description: "Render a chart",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
      );

      expect(finished.outcome).toEqual({
        type: "success",
        pendingToolCallIds: ["tc-ui"],
      });
    });

    it("a completed run still ends as a success", async () => {
      const finished = await abortDuringSnapshot([
        { type: "text-delta", payload: { text: "done" } },
      ]);

      expect(finished.outcome).toBeUndefined();
    });
  });

  // The teardown fires on normal completion too (RxJS closes the subscription
  // either way). This proves the abort that fires there is harmless: the run
  // still finishes and both messages are persisted.
  describe("normal completion is unaffected", () => {
    it("a run that completes still emits RUN_FINISHED and persists messages", async () => {
      const memory = new MockMemory();
      const agent = new Agent({
        id: "test-agent",
        name: "test-agent",
        instructions: "Test",
        memory,
        model: new MastraLanguageModelV2Mock({
          doStream: async () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "text-delta" as const,
                  id: "t1",
                  delta: "Hello back",
                });
                controller.enqueue({
                  type: "finish" as const,
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                  finishReason: "stop" as const,
                });
                controller.close();
              },
            }),
            request: { body: {} },
            response: undefined,
          }),
        }) as any,
      });

      const events = await collectEvents(
        new MastraAgent({
          agentId: "test-agent",
          agent,
          resourceId: "resource-1",
        }),
        makeInput({
          threadId: "thread-complete",
          messages: [{ id: "1", role: "user", content: "Hi there" }] as any,
        }),
      );

      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

      const { messages } = await memory.recall({
        threadId: "thread-complete",
        resourceId: "resource-1",
        selectBy: { last: 50 },
      } as any);

      const texts = messages.map((m: any) =>
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? ""),
      );
      expect(texts.some((t: string) => t.includes("Hi there"))).toBe(true);
      expect(texts.some((t: string) => t.includes("Hello back"))).toBe(true);
    });
  });
});
