import { describe, expect, it, vi } from "vitest";
import { EventType, HttpAgent, type BaseEvent } from "@ag-ui/client";
import { handleAGUIRequest, isAGUIRequest, parseRunAgentInput, toThreadRequest } from "./http";
import { CloudflareAgentsClient } from "./client";
import { SDKS, chunks, turn } from "./test-utils";

const sdk = SDKS[0]!;

const post = (body: unknown, init: RequestInit = {}) =>
  new Request("https://worker.example/agui", {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

describe("handleAGUIRequest", () => {
  it("serves a run to a plain HttpAgent", async () => {
    const model = sdk.model([turn(chunks.text("t1", "Hi from a Worker."))]);
    const worker = (request: Request) =>
      handleAGUIRequest(request, (run) =>
        sdk.ai.streamText({ model: model as any, messages: run.messages, abortSignal: run.abortSignal }),
      );
    const client = new HttpAgent({
      url: "https://worker.example/agui",
      fetch: async (url, init) => worker(new Request(url, init)),
    });
    client.messages = [{ id: "u1", role: "user", content: "Hi" }];

    await client.runAgent();

    expect(client.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hi from a Worker." });
  });

  it("writes Server-Sent Events", async () => {
    const response = await handleAGUIRequest(
      post({ threadId: "t", runId: "r", messages: [] }),
      () => ({ fullStream: (async function* () {})() }),
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const text = await response.text();
    const events = text.trim().split("\n\n").map((frame) => JSON.parse(frame.replace(/^data: /, "")));
    expect(events.map((e: BaseEvent) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
  });

  it("answers a CORS preflight and keeps the CORS headers on errors", async () => {
    const options = { headers: { "Access-Control-Allow-Origin": "https://app.example" } };
    const preflight = await handleAGUIRequest(new Request("https://worker.example/agui", { method: "OPTIONS" }), vi.fn(), options);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const bad = await handleAGUIRequest(post({ runId: "r", messages: [] }), vi.fn(), options);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("rejects other methods and bad bodies", async () => {
    const handler = vi.fn();
    expect((await handleAGUIRequest(new Request("https://worker.example/agui"), handler)).status).toBe(405);
    expect((await handleAGUIRequest(post({ runId: "r", messages: [] }), handler)).status).toBe(400);
    expect(
      (await handleAGUIRequest(new Request("https://worker.example/agui", { method: "POST", body: "{" }), handler))
        .status,
    ).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("aborts the run when the client goes away", async () => {
    let signal: AbortSignal | undefined;
    const response = await handleAGUIRequest(post({ threadId: "t", runId: "r", messages: [] }), (run) => {
      signal = run.abortSignal;
      // A model stream that only ends when the run is aborted.
      const ended = new Promise((resolve) => run.abortSignal.addEventListener("abort", resolve));
      return { fullStream: (async function* () { await ended; })() };
    });
    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await reader.cancel();
    expect(signal!.aborted).toBe(true);
  });
});

describe("parseRunAgentInput", () => {
  it("fills the optional arrays", () => {
    expect(parseRunAgentInput({ threadId: "t", runId: "r", messages: [] })).toEqual({
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    });
  });

  it.each([
    [null, "Expected a RunAgentInput object"],
    [{ runId: "r", messages: [] }, "threadId is required"],
    [{ threadId: "t", messages: [] }, "runId is required"],
    [{ threadId: "t", runId: "r" }, "messages must be an array"],
  ])("rejects %j", (body, message) => {
    expect(() => parseRunAgentInput(body)).toThrow(message);
  });
});

describe("toThreadRequest", () => {
  const run = (path: string, body: unknown = { threadId: "thread 7", runId: "r", messages: [] }) =>
    new Request(`https://worker.example${path}`, {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("moves the thread id into the agent's path", async () => {
    const routed = await toThreadRequest(run("/agents/assistant"));
    expect(routed.url).toBe("https://worker.example/agents/assistant/thread%207");
    expect(await routed.json()).toMatchObject({ threadId: "thread 7", runId: "r" });
    expect(routed.headers.get("accept")).toBe("text/event-stream");
  });

  it("honours a custom prefix", async () => {
    const routed = await toThreadRequest(run("/ai/assistant"), { prefix: "/ai/" });
    expect(routed.url).toBe("https://worker.example/ai/assistant/thread%207");
  });

  it("leaves requests that already name a thread, or are not runs, alone", async () => {
    const named = run("/agents/assistant/t1");
    expect(await toThreadRequest(named)).toBe(named);
    const get = new Request("https://worker.example/agents/assistant");
    expect(await toThreadRequest(get)).toBe(get);
    const elsewhere = run("/api/assistant");
    expect(await toThreadRequest(elsewhere)).toBe(elsewhere);
  });

  it("keeps the body readable when it has no thread id", async () => {
    const routed = await toThreadRequest(run("/agents/assistant", { runId: "r" }));
    expect(routed.url).toBe("https://worker.example/agents/assistant");
    expect(await routed.json()).toEqual({ runId: "r" });
  });
});

describe("isAGUIRequest", () => {
  it("matches POSTs that accept an event stream", () => {
    expect(isAGUIRequest(post({}))).toBe(true);
    expect(isAGUIRequest(new Request("https://x", { method: "POST" }))).toBe(false);
    expect(isAGUIRequest(new Request("https://x", { headers: { Accept: "text/event-stream" } }))).toBe(false);
  });
});

describe("CloudflareAgentsClient", () => {
  class Socket extends EventTarget {
    static last: Socket | undefined;
    readyState = 0;
    sent: string[] = [];
    constructor(readonly url: string) {
      super();
      Socket.last = this;
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    receive(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
  }

  /** Starts a run and opens the socket it creates. Returns the socket and run id. */
  async function start(client: CloudflareAgentsClient, run: () => Promise<unknown>) {
    Socket.last = undefined;
    const result = run();
    await vi.waitFor(() => expect(Socket.last).toBeDefined());
    const socket = Socket.last!;
    socket.open();
    const runId: string = JSON.parse(socket.sent[0]!).input.runId;
    return { socket, runId, result };
  }

  it("fails the run when the socket closes before it finishes", async () => {
    const client = new CloudflareAgentsClient({ url: "wss://w.example/agents/a", WebSocket: Socket as any });
    const { socket, runId, result } = await start(client, () => client.runAgent());
    socket.receive({
      type: "ag-ui:event",
      runId,
      event: { type: EventType.RUN_STARTED, threadId: client.threadId, runId },
    });
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
    await expect(result).rejects.toThrow("WebSocket closed before the run finished (code 1006)");
  });

  it("sends an abort frame when the run is aborted", async () => {
    const client = new CloudflareAgentsClient({ url: "wss://w.example/agents/a", WebSocket: Socket as any });
    const { socket, runId } = await start(client, () => client.runAgent().catch(() => {}));
    client.abortRun();
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: "ag-ui:abort", runId });
  });

  it("does not start a run aborted while the socket was connecting", async () => {
    const client = new CloudflareAgentsClient({ url: "wss://w.example/agents/a", WebSocket: Socket as any });
    Socket.last = undefined;
    const result = client.runAgent();
    await vi.waitFor(() => expect(Socket.last).toBeDefined());
    const socket = Socket.last!;
    client.abortRun();
    socket.open();
    await result;
    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(3);
  });

  it("ignores frames for other runs and other protocols", async () => {
    const client = new CloudflareAgentsClient({ url: "wss://w.example/agents/a", WebSocket: Socket as any });
    const events: BaseEvent[] = [];
    client.subscribe({ onEvent: ({ event }) => void events.push(event) });
    const { socket, runId, result } = await start(client, () => client.runAgent());
    const send = (event: Record<string, unknown>) => socket.receive({ type: "ag-ui:event", runId, event });
    socket.receive({ type: "cf_agent_state", state: {} });
    socket.receive({ type: "ag-ui:event", runId: "someone-else", event: { type: EventType.RUN_STARTED } });
    send({ type: EventType.RUN_STARTED, threadId: client.threadId, runId });
    send({ type: EventType.RUN_FINISHED, threadId: client.threadId, runId });
    await result;
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });
});
