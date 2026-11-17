import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AGUIError,
  BaseEvent,
  EventType,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateSnapshotEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
} from "@ag-ui/core";
import { HttpAgent } from "../http";
import { ReplayAgent, createEventRecorder, recordEvents, splitRecordedRuns } from "../replay";
import { EventEncoder } from "@ag-ui/encoder";

function textRun(options: {
  threadId: string;
  runId: string;
  messageId: string;
  text: string;
  state?: unknown;
}): BaseEvent[] {
  const events: BaseEvent[] = [
    {
      type: EventType.RUN_STARTED,
      threadId: options.threadId,
      runId: options.runId,
      protocolVersion: "1.0",
    } as RunStartedEvent,
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: options.messageId,
      role: "assistant",
    } as TextMessageStartEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: options.messageId,
      delta: options.text,
    } as TextMessageContentEvent,
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: options.messageId,
    } as TextMessageEndEvent,
  ];
  if (options.state !== undefined) {
    events.push({
      type: EventType.STATE_SNAPSHOT,
      snapshot: options.state,
    } as StateSnapshotEvent);
  }
  events.push({
    type: EventType.RUN_FINISHED,
    threadId: options.threadId,
    runId: options.runId,
  } as RunFinishedEvent);
  return events;
}

function sseFetch(stream: BaseEvent[]): HttpAgent["fetch"] {
  const encoder = new EventEncoder();
  const body = stream.map((event) => encoder.encodeSSE(event)).join("");
  return vi.fn(async () => {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

describe("splitRecordedRuns", () => {
  it("splits a concatenated recording on each RUN_STARTED", () => {
    const first = textRun({
      threadId: "t",
      runId: "r1",
      messageId: "m1",
      text: "one",
    });
    const second = textRun({
      threadId: "t",
      runId: "r2",
      messageId: "m2",
      text: "two",
    });
    expect(splitRecordedRuns([...first, ...second])).toEqual([first, second]);
  });

  it("keeps a RUN_ERROR-only stream as a single run", () => {
    const errorOnly: BaseEvent[] = [
      { type: EventType.RUN_ERROR, message: "gone" } as RunErrorEvent,
    ];
    expect(splitRecordedRuns(errorOnly)).toEqual([errorOnly]);
  });

  it("splits a successful run followed by an error-only run", () => {
    const first = textRun({
      threadId: "t",
      runId: "r1",
      messageId: "m1",
      text: "ok",
    });
    const second: BaseEvent[] = [{ type: EventType.RUN_ERROR, message: "boom" } as RunErrorEvent];
    expect(splitRecordedRuns([...first, ...second])).toEqual([first, second]);
  });

  it("splits two consecutive error-only runs", () => {
    const first: BaseEvent[] = [
      { type: EventType.RUN_ERROR, message: "first error" } as RunErrorEvent,
    ];
    const second: BaseEvent[] = [
      { type: EventType.RUN_ERROR, message: "second error" } as RunErrorEvent,
    ];
    expect(splitRecordedRuns([...first, ...second])).toEqual([first, second]);
  });

  it("splits an error-only run followed by a successful run", () => {
    const first: BaseEvent[] = [
      { type: EventType.RUN_ERROR, message: "first error" } as RunErrorEvent,
    ];
    const second = textRun({
      threadId: "t",
      runId: "r2",
      messageId: "m2",
      text: "recovered",
    });
    expect(splitRecordedRuns([...first, ...second])).toEqual([first, second]);
  });
});

describe("recordEvents and ReplayAgent", () => {
  it("records a stub HttpAgent fixture fetch and replays the same messages and state", async () => {
    const stream = textRun({
      threadId: "live-thread",
      runId: "live-run",
      messageId: "msg-live",
      text: "Hello from fixture",
      state: { answered: true },
    });
    const live = new HttpAgent({
      url: "https://example.test/agent",
      threadId: "live-thread",
      fetch: sseFetch(stream),
      debug: false,
    });
    const recorder = recordEvents(live);
    await live.runAgent({ runId: "live-run" });

    const json = JSON.stringify(recorder);
    const replay = new ReplayAgent(JSON.parse(json) as BaseEvent[], {
      threadId: "replay-thread",
      debug: false,
    });
    await replay.runAgent({ runId: "replay-run" });

    expect(replay.messages.map((message) => message.content)).toEqual(
      live.messages.map((message) => message.content),
    );
    expect(replay.state).toEqual(live.state);
    expect(replay.state).toEqual({ answered: true });
  });

  it("stop() unsubscribes so a later run is not recorded", async () => {
    const stream = textRun({
      threadId: "t",
      runId: "r1",
      messageId: "m1",
      text: "first",
    });
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      threadId: "t",
      fetch: sseFetch(stream),
      debug: false,
    });
    const recorder = recordEvents(agent);
    await agent.runAgent({ runId: "r1" });
    const countAfterFirst = recorder.events.length;
    expect(countAfterFirst).toBeGreaterThan(0);
    expect(agent.subscribers).toContain(recorder.subscriber);

    recorder.stop();
    recorder.stop();
    expect(agent.subscribers).not.toContain(recorder.subscriber);

    await agent.runAgent({ runId: "r2" });
    expect(recorder.events).toHaveLength(countAfterFirst);

    const detached = createEventRecorder();
    expect(() => {
      detached.stop();
      detached.stop();
    }).not.toThrow();
  });

  it("plays one recorded run per runAgent() call, in order", async () => {
    const recording = [
      ...textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "first" }),
      ...textRun({ threadId: "t", runId: "r2", messageId: "m2", text: "second" }),
    ];
    const agent = new ReplayAgent(recording, { threadId: "t", debug: false });

    const first = await agent.runAgent({ runId: "new-1" });
    expect(first.newMessages.map((message) => message.content)).toEqual(["first"]);

    const second = await agent.runAgent({ runId: "new-2" });
    expect(second.newMessages.map((message) => message.content)).toEqual(["second"]);
    expect(agent.messages.map((message) => message.content)).toEqual(["first", "second"]);
  });

  it("plays a successful run then an error-only run across two runAgent() calls", async () => {
    const recording: BaseEvent[] = [
      ...textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "ok" }),
      { type: EventType.RUN_ERROR, message: "later failure" } as RunErrorEvent,
    ];
    const agent = new ReplayAgent(recording, { threadId: "t", debug: false });
    const errors: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        errors.push(event.message);
      },
    });

    const first = await agent.runAgent({ runId: "play-1" });
    expect(first.newMessages.map((message) => message.content)).toEqual(["ok"]);
    expect(errors).toEqual([]);

    const second = await agent.runAgent({ runId: "play-2" });
    expect(second.newMessages).toEqual([]);
    expect(errors).toEqual(["later failure"]);
  });

  it("plays two error-only runs across two runAgent() calls without verifier failure", async () => {
    const recording: BaseEvent[] = [
      { type: EventType.RUN_ERROR, message: "err-1" } as RunErrorEvent,
      { type: EventType.RUN_ERROR, message: "err-2" } as RunErrorEvent,
    ];
    const agent = new ReplayAgent(recording, { threadId: "t", debug: false });
    const errors: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        errors.push(event.message);
      },
    });

    await agent.runAgent({ runId: "play-1" });
    expect(errors).toEqual(["err-1"]);

    await agent.runAgent({ runId: "play-2" });
    expect(errors).toEqual(["err-1", "err-2"]);
  });

  it("plays an error-only run then a successful run across two runAgent() calls", async () => {
    const recording: BaseEvent[] = [
      { type: EventType.RUN_ERROR, message: "err-1" } as RunErrorEvent,
      ...textRun({ threadId: "t", runId: "r2", messageId: "m2", text: "recovered" }),
    ];
    const agent = new ReplayAgent(recording, { threadId: "t", debug: false });
    const errors: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        errors.push(event.message);
      },
    });

    const first = await agent.runAgent({ runId: "play-1" });
    expect(first.newMessages).toEqual([]);
    expect(errors).toEqual(["err-1"]);

    const second = await agent.runAgent({ runId: "play-2" });
    expect(second.newMessages.map((message) => message.content)).toEqual(["recovered"]);
    expect(errors).toEqual(["err-1"]);
  });

  it("emits RUN_ERROR when every recorded run has already been played", async () => {
    const agent = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "only" }),
      { threadId: "t", debug: false },
    );
    await agent.runAgent({ runId: "r1" });

    const seen: string[] = [];
    agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        seen.push(event.message);
      },
    });
    await agent.runAgent({ runId: "r2" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/no more recorded runs/i);
    expect(seen[0]).toMatch(/played 1 of 1/);
  });

  it("rewrites threadId and runId on lifecycle events to the current input", async () => {
    const agent = new ReplayAgent(
      textRun({ threadId: "recorded-thread", runId: "recorded-run", messageId: "m1", text: "hi" }),
      { threadId: "live-thread", debug: false },
    );
    const started: Array<{ threadId: string; runId: string }> = [];
    const finished: Array<{ threadId: string; runId: string }> = [];
    agent.subscribe({
      onRunStartedEvent: ({ event }) => {
        started.push({ threadId: event.threadId, runId: event.runId });
      },
      onRunFinishedEvent: ({ event }) => {
        finished.push({ threadId: event.threadId, runId: event.runId });
      },
    });

    await agent.runAgent({ runId: "live-run" });

    expect(started).toEqual([{ threadId: "live-thread", runId: "live-run" }]);
    expect(finished).toEqual([{ threadId: "live-thread", runId: "live-run" }]);
  });

  it("rejects a malformed recording the same way a malformed server stream is rejected", async () => {
    const agent = new ReplayAgent(
      [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "orphan",
          delta: "no run",
        } as TextMessageContentEvent,
      ],
      { debug: false },
    );

    await expect(agent.runAgent({ runId: "bad" })).rejects.toBeInstanceOf(AGUIError);
    const again = new ReplayAgent(
      [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "orphan",
          delta: "no run",
        } as TextMessageContentEvent,
      ],
      { debug: false },
    );
    await expect(again.runAgent({ runId: "bad" })).rejects.toThrow(
      /First event must be 'RUN_STARTED'/,
    );
  });

  it("fires subscriber callbacks on replay the way a live run does", async () => {
    const stream = textRun({
      threadId: "t",
      runId: "r1",
      messageId: "m1",
      text: "streamed",
      state: { n: 1 },
    });
    const live = new HttpAgent({
      url: "https://example.test/agent",
      threadId: "t",
      fetch: sseFetch(stream),
      debug: false,
    });
    const recorder = createEventRecorder();
    const liveEvents: string[] = [];
    await live.runAgent(
      { runId: "r1" },
      {
        ...recorder.subscriber,
        onEvent: (params) => {
          liveEvents.push(params.event.type);
          return recorder.subscriber.onEvent?.(params);
        },
      },
    );

    const replay = new ReplayAgent(recorder.events, { threadId: "t", debug: false });
    const replayEvents: string[] = [];
    const onText = vi.fn();
    const onStarted = vi.fn();
    const onFinished = vi.fn();
    await replay.runAgent(
      { runId: "r2" },
      {
        onEvent: ({ event }) => {
          replayEvents.push(event.type);
        },
        onTextMessageContentEvent: onText,
        onRunStartedEvent: onStarted,
        onRunFinishedEvent: onFinished,
      },
    );

    expect(replayEvents).toEqual(liveEvents);
    expect(onText).toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("clones with an independent copy of the recording and playback cursor", async () => {
    const recording = [
      ...textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "one" }),
      ...textRun({ threadId: "t", runId: "r2", messageId: "m2", text: "two" }),
    ];
    const agent = new ReplayAgent(recording, { threadId: "t", debug: false, delayMs: 0 });
    await agent.runAgent({ runId: "r1" });

    const cloned = agent.clone();
    expect(cloned).toBeInstanceOf(ReplayAgent);
    expect(cloned).not.toBe(agent);
    expect(cloned.events).toEqual(agent.events);
    expect(cloned.events).not.toBe(agent.events);
    expect(cloned.nextRunIndex).toBe(1);
    expect(cloned.delayMs).toBe(0);
    expect(cloned.abortController).not.toBe(agent.abortController);

    cloned.events.push({ type: EventType.RUN_ERROR, message: "mutated" } as RunErrorEvent);
    expect(agent.events).toHaveLength(recording.length);

    const second = await cloned.runAgent({ runId: "r2" });
    expect(second.newMessages.map((message) => message.content)).toEqual(["two"]);
    expect(agent.nextRunIndex).toBe(1);
  });
});

describe("ReplayAgent abort and delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops playback promptly when abortRun() is called mid-delay", async () => {
    const agent = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "slow" }),
      { threadId: "t", debug: false, delayMs: 100 },
    );
    const types: string[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        types.push(event.type);
      },
    });

    const done = agent.runAgent({ runId: "r1" });
    await vi.advanceTimersByTimeAsync(100);
    expect(types).toEqual([EventType.RUN_STARTED]);

    agent.abortRun();
    await done;

    expect(types[types.length - 1]).toBe(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);
    expect(agent.isRunning).toBe(false);
  });

  it("emits an abort error when the signal aborts between run() and subscribe", async () => {
    const agent = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "late" }),
      { threadId: "t", debug: false },
    );
    const stream = agent.run({
      threadId: "t",
      runId: "r1",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    });
    agent.abortRun();

    const types: string[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.subscribe({
        next: (event) => types.push(event.type),
        error: reject,
        complete: resolve,
      });
    });

    expect(types).toEqual([EventType.RUN_ERROR]);
  });

  it("honours a per-event delayMs function", async () => {
    const delays: Array<{ type: string; index: number }> = [];
    const agent = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "x" }),
      {
        threadId: "t",
        debug: false,
        delayMs: (event, index) => {
          delays.push({ type: event.type, index });
          return 0;
        },
      },
    );
    await agent.runAgent({ runId: "r1" });
    expect(delays[0]).toEqual({ type: EventType.RUN_STARTED, index: 0 });
    expect(delays.length).toBeGreaterThan(1);
  });

  it("rejects runAgent() and clears timers when delayMs throws on a later event", async () => {
    const delayError = new Error("delay boom");
    const agent = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "x" }),
      {
        threadId: "t",
        debug: false,
        delayMs: (_event, index) => {
          if (index === 0) return 10;
          throw delayError;
        },
      },
    );

    const rejected = expect(agent.runAgent({ runId: "r1" })).rejects.toThrow("delay boom");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    expect(vi.getTimerCount()).toBe(0);
    expect(agent.isRunning).toBe(false);
  });
});

describe("createEventRecorder serialization", () => {
  it("round-trips through JSON.stringify into ReplayAgent", async () => {
    const recorder = createEventRecorder();
    const source = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "saved" }),
      { threadId: "t", debug: false },
    );
    await source.runAgent({ runId: "r1" }, recorder.subscriber);

    const parsed = JSON.parse(JSON.stringify(recorder)) as BaseEvent[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.type).toBe(EventType.RUN_STARTED);

    const replay = new ReplayAgent(parsed, { threadId: "t", debug: false });
    const result = await replay.runAgent({ runId: "r-json" });
    expect(result.newMessages.map((message) => message.content)).toEqual(["saved"]);
  });
});

describe("ReplayAgent run() input typing", () => {
  it("does not require a network-shaped RunAgentInput beyond the pipeline's", async () => {
    const agent = new ReplayAgent(
      textRun({ threadId: "t", runId: "r1", messageId: "m1", text: "ok" }),
      { threadId: "t", debug: false },
    );
    const input: RunAgentInput = {
      threadId: "t",
      runId: "r1",
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      messages: [],
    };
    const types: string[] = [];
    await new Promise<void>((resolve, reject) => {
      agent.run(input).subscribe({
        next: (event) => types.push(event.type),
        error: reject,
        complete: resolve,
      });
    });
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});
