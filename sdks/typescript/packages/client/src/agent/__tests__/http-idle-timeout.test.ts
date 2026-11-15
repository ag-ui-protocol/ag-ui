import { EventType, AGUIError } from "@ag-ui/core";
import * as encoder from "@ag-ui/encoder";
import * as proto from "@ag-ui/proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAgent } from "../http";
import { HttpAgentIdleTimeoutError } from "../../run/http-request";
import type { HttpAgentFetchFn } from "../types";
import type { AgentSubscriber } from "../subscriber";
import type { BaseEvent } from "@ag-ui/core";

const textEncoder = new TextEncoder();
const protoEncoder = new encoder.EventEncoder({ accept: proto.AGUI_MEDIA_TYPE });

function sseFrame(event: object): Uint8Array {
  return textEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function sseComment(comment: string): Uint8Array {
  return textEncoder.encode(`: ${comment}\n\n`);
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function attachAbort(signal: AbortSignal | null | undefined, onAbort: () => void): void {
  if (!signal) return;
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
}

interface BodyHandle {
  push: (chunk: Uint8Array) => void;
  close: () => void;
}

function hangingHeadersFetch(): HttpAgentFetchFn {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      attachAbort(init?.signal, () => reject(abortError()));
    });
}

function streamingFetch(
  headers: HeadersInit,
  onReady: (body: BodyHandle) => void,
): HttpAgentFetchFn {
  return (_url, init) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    attachAbort(init?.signal, () => {
      try {
        controller.error(abortError());
      } catch {
        // already closed or errored
      }
    });
    onReady({
      push: (chunk) => controller.enqueue(chunk),
      close: () => controller.close(),
    });
    return Promise.resolve(new Response(stream, { status: 200, headers }));
  };
}

const sseHeaders = { "content-type": "text/event-stream" };
const protoHeaders = { "content-type": proto.AGUI_MEDIA_TYPE };

function runEvents(threadId: string, runId: string, text: string): object[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId },
    { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" },
    { type: EventType.RUN_FINISHED, threadId, runId },
  ];
}

describe("HttpAgent idleTimeoutMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects 0, negative, NaN, and non-finite values at construction", () => {
    const url = "https://example.test/agent";
    for (const idleTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2000"]) {
      expect(() => new HttpAgent({ url, idleTimeoutMs: idleTimeoutMs as number })).toThrow(
        AGUIError,
      );
      expect(() => new HttpAgent({ url, idleTimeoutMs: idleTimeoutMs as number })).toThrow(
        /idleTimeoutMs/,
      );
    }
  });

  it("accepts a positive finite timeout and copies it on clone()", () => {
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      idleTimeoutMs: 1500.5,
    });
    expect(agent.idleTimeoutMs).toBe(1500.5);
    expect(agent.clone().idleTimeoutMs).toBe(1500.5);
  });

  it("times out if response headers never arrive", async () => {
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: hangingHeadersFetch(),
      idleTimeoutMs: 2_000,
    });
    const onRunFailed = vi.fn();
    const run = agent.runAgent({ runId: "headers-stall" }, { onRunFailed });
    const rejected = expect(run).rejects.toBeInstanceOf(HttpAgentIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(onRunFailed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await expect(run).rejects.toMatchObject({
      code: "IDLE_TIMEOUT",
      idleTimeoutMs: 2_000,
    });
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onRunFailed.mock.calls[0][0].error).toBeInstanceOf(HttpAgentIdleTimeoutError);
    expect(onRunFailed.mock.calls[0][0].error.message).toContain("2000");
  });

  it("delivers events received before a mid-stream stall, then errors once", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(sseHeaders, (handle) => {
        body = handle;
      }),
      idleTimeoutMs: 2_000,
    });

    const seen: string[] = [];
    const onRunFailed = vi.fn();
    const subscriber: AgentSubscriber = {
      onEvent: ({ event }) => {
        seen.push(event.type);
      },
      onRunFailed,
    };
    const run = agent.runAgent({ runId: "mid-stall" }, subscriber);
    const rejected = expect(run).rejects.toBeInstanceOf(HttpAgentIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(0);
    expect(body).toBeDefined();
    const threadId = agent.threadId;
    body!.push(sseFrame({ type: EventType.RUN_STARTED, threadId, runId: "mid-stall" }));
    body!.push(
      sseFrame({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
    );
    body!.push(
      sseFrame({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "partial" }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  it("keeps the run alive when SSE comment keepalives arrive within the idle window", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(sseHeaders, (handle) => {
        body = handle;
      }),
      idleTimeoutMs: 2_000,
    });

    const run = agent.runAgent({ runId: "keepalive" });
    await vi.advanceTimersByTimeAsync(0);
    const threadId = agent.threadId;
    body!.push(sseFrame({ type: EventType.RUN_STARTED, threadId, runId: "keepalive" }));
    await vi.advanceTimersByTimeAsync(1_500);
    body!.push(sseComment("ping"));
    await vi.advanceTimersByTimeAsync(1_500);
    body!.push(sseComment("ping"));
    await vi.advanceTimersByTimeAsync(1_500);
    for (const event of runEvents(threadId, "keepalive", "alive").slice(1)) {
      body!.push(sseFrame(event));
    }
    body!.close();
    await vi.advanceTimersByTimeAsync(0);

    await expect(run).resolves.toMatchObject({
      newMessages: [expect.objectContaining({ content: "alive" })],
    });
  });

  it("clears the timer on a normal completion so a late tick cannot fail the run", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(sseHeaders, (handle) => {
        body = handle;
      }),
      idleTimeoutMs: 2_000,
    });

    const run = agent.runAgent({ runId: "ok" });
    await vi.advanceTimersByTimeAsync(0);
    for (const event of runEvents(agent.threadId, "ok", "done")) {
      body!.push(sseFrame(event));
    }
    body!.close();
    await vi.advanceTimersByTimeAsync(0);
    const result = await run;

    expect(result.newMessages[0]).toMatchObject({ content: "done" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(agent.isRunning).toBe(false);
  });

  it("reports abortRun() during a stall as an abort, not a timeout", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(sseHeaders, (handle) => {
        body = handle;
      }),
      idleTimeoutMs: 2_000,
    });

    const seen: Array<Record<string, unknown>> = [];
    const onRunFailed = vi.fn();
    const run = agent.runAgent(
      { runId: "user-abort" },
      {
        onRunErrorEvent: ({ event }) => {
          seen.push(event as unknown as Record<string, unknown>);
        },
        onRunFailed,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    body!.push(
      sseFrame({
        type: EventType.RUN_STARTED,
        threadId: agent.threadId,
        runId: "user-abort",
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    agent.abortRun();
    await vi.advanceTimersByTimeAsync(0);

    await expect(run).resolves.toBeDefined();
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(seen[0]?.code).toBe("abort");
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Agent execution failed"),
      expect.anything(),
    );
  });

  it("does not time out when idleTimeoutMs is unset", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(sseHeaders, (handle) => {
        body = handle;
      }),
    });
    const onRunFailed = vi.fn();
    const run = agent.runAgent({ runId: "no-timeout" }, { onRunFailed });

    await vi.advanceTimersByTimeAsync(0);
    body!.push(
      sseFrame({
        type: EventType.RUN_STARTED,
        threadId: agent.threadId,
        runId: "no-timeout",
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(agent.isRunning).toBe(true);

    agent.abortRun();
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toBeDefined();
    expect(onRunFailed).not.toHaveBeenCalled();
  });

  it("times out a protobuf stream that stalls after some bytes", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(protoHeaders, (handle) => {
        body = handle;
      }),
      idleTimeoutMs: 2_000,
    });

    const seen: string[] = [];
    const onRunFailed = vi.fn();
    const run = agent.runAgent(
      { runId: "proto-stall" },
      {
        onEvent: ({ event }: { event: BaseEvent }) => {
          seen.push(event.type);
        },
        onRunFailed,
      },
    );
    const rejected = expect(run).rejects.toBeInstanceOf(HttpAgentIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(0);
    body!.push(
      protoEncoder.encodeBinary({
        type: EventType.RUN_STARTED,
        threadId: agent.threadId,
        runId: "proto-stall",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([EventType.RUN_STARTED]);

    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([EventType.RUN_STARTED]);
  });

  it("errors the Observable once with HttpAgentIdleTimeoutError", async () => {
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: hangingHeadersFetch(),
      idleTimeoutMs: 1_000,
      threadId: "t-obs",
    });
    const errors: unknown[] = [];
    const input = {
      threadId: agent.threadId,
      runId: "obs",
      tools: [],
      context: [],
      forwardedProps: {},
      state: agent.state,
      messages: agent.messages,
    };

    agent.run(input).subscribe({
      error: (err) => errors.push(err),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HttpAgentIdleTimeoutError);
  });
});
