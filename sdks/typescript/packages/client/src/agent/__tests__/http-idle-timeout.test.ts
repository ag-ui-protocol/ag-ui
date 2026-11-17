import { EventType, AGUIError } from "@ag-ui/core";
import * as encoder from "@ag-ui/encoder";
import * as proto from "@ag-ui/proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpAgent, MAX_IDLE_TIMEOUT_MS } from "../index";
import { HttpAgentIdleTimeoutError, runHttpRequest } from "../../run/http-request";
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
  status = 200,
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
    return Promise.resolve(new Response(stream, { status, headers }));
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

  it("enforces MAX_IDLE_TIMEOUT_MS on HttpAgent and runHttpRequest", () => {
    const url = "https://example.test/agent";
    expect(MAX_IDLE_TIMEOUT_MS).toBe(2_147_483_647);

    const maxAgent = new HttpAgent({ url, idleTimeoutMs: 2_147_483_647 });
    expect(maxAgent.idleTimeoutMs).toBe(2_147_483_647);

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    for (const idleTimeoutMs of [2_147_483_648, thirtyDaysMs]) {
      expect(() => new HttpAgent({ url, idleTimeoutMs })).toThrow(AGUIError);
      expect(() => new HttpAgent({ url, idleTimeoutMs })).toThrow(/idleTimeoutMs/);
      expect(() => new HttpAgent({ url, idleTimeoutMs })).toThrow(/2147483647/);
    }

    const unusedFetch = vi.fn();
    expect(() => runHttpRequest(unusedFetch, { idleTimeoutMs: 2_147_483_648 })).toThrow(AGUIError);
    expect(() => runHttpRequest(unusedFetch, { idleTimeoutMs: 2_147_483_648 })).toThrow(
      /idleTimeoutMs/,
    );
    expect(unusedFetch).not.toHaveBeenCalled();
  });

  it("resets the idle timer per chunk on a slow streaming non-2xx error body", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(
        { "content-type": "application/json" },
        (handle) => {
          body = handle;
        },
        503,
      ),
      idleTimeoutMs: 2_000,
    });

    const onRunFailed = vi.fn();
    const run = agent.runAgent({ runId: "slow-503" }, { onRunFailed });
    const caught = run.then(
      () => undefined,
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(body).toBeDefined();

    await vi.advanceTimersByTimeAsync(1_500);
    body!.push(textEncoder.encode('{"error":'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onRunFailed).not.toHaveBeenCalled();

    body!.push(textEncoder.encode('"service '));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onRunFailed).not.toHaveBeenCalled();

    body!.push(textEncoder.encode('unavailable"}'));
    body!.close();
    await vi.advanceTimersByTimeAsync(0);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HttpAgentIdleTimeoutError);
    expect(err).toMatchObject({
      status: 503,
      payload: { error: "service unavailable" },
    });
    expect((err as Error).message).toBe('HTTP 503: {"error":"service unavailable"}');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to response.text() on a non-2xx response without a body reader", async () => {
    const mockResponse = {
      ok: false,
      status: 502,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: vi.fn().mockResolvedValue('{"error":"bad gateway"}'),
    } as unknown as Response;

    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: () => Promise.resolve(mockResponse),
      idleTimeoutMs: 2_000,
    });

    await expect(agent.runAgent({ runId: "no-reader-502" })).rejects.toMatchObject({
      status: 502,
      payload: { error: "bad gateway" },
    });
    expect(mockResponse.text).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a non-2xx response whose error body stalls after one chunk", async () => {
    let body: BodyHandle | undefined;
    const agent = new HttpAgent({
      url: "https://example.test/agent",
      fetch: streamingFetch(
        { "content-type": "application/json" },
        (handle) => {
          body = handle;
        },
        503,
      ),
      idleTimeoutMs: 2_000,
    });

    const onRunFailed = vi.fn();
    const run = agent.runAgent({ runId: "stalled-503" }, { onRunFailed });
    const rejected = expect(run).rejects.toBeInstanceOf(HttpAgentIdleTimeoutError);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    body!.push(textEncoder.encode('{"error":'));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(onRunFailed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await expect(run).rejects.toMatchObject({
      code: "IDLE_TIMEOUT",
      idleTimeoutMs: 2_000,
    });
    expect(onRunFailed).toHaveBeenCalledTimes(1);
  });

  it("clears the idle timer and removes the abort listener on unsubscribe", async () => {
    const abortController = new AbortController();
    const addListenerSpy = vi.spyOn(abortController.signal, "addEventListener");
    const removeListenerSpy = vi.spyOn(abortController.signal, "removeEventListener");
    const cancel = vi.fn(() => Promise.resolve());
    const neverEndingStream = new ReadableStream<Uint8Array>({ cancel });
    const onIdleTimeout = vi.fn();
    const errors: unknown[] = [];

    const subscription = runHttpRequest(
      () => Promise.resolve(new Response(neverEndingStream, { status: 200, headers: sseHeaders })),
      {
        idleTimeoutMs: 2_000,
        abortSignal: abortController.signal,
        onIdleTimeout,
      },
    ).subscribe({
      error: (err) => errors.push(err),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const abortCall = addListenerSpy.mock.calls.find(([type]) => type === "abort");
    expect(abortCall).toBeDefined();

    subscription.unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListenerSpy).toHaveBeenCalledWith("abort", abortCall![1]);
    expect(cancel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toEqual([]);
    expect(onIdleTimeout).not.toHaveBeenCalled();
  });
});
