import { describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent, type Message } from "@ag-ui/client";
import { withAGUI, type AGUIConnection } from "./agent";
import { CloudflareAgentsClient, CloudflareAgentsHttpAgent } from "./client";
import type { AGUIRun } from "./run";
import { EVENT_FRAME, RUN_FRAME, ABORT_FRAME } from "./protocol";
import { SDKS, chunks, turn } from "./test-utils";

const sdk = SDKS[0]!;
const { ai } = sdk;

/** Stands in for the Agents SDK's `Agent`: state, request and socket hooks. */
class FakeAgent<State> {
  state: State;
  readonly baseRequests: Request[] = [];
  readonly baseMessages: unknown[] = [];
  readonly closed: string[] = [];
  readonly released = vi.fn();
  readonly keepAlive = vi.fn(async () => this.released);
  /** Durable Object storage, as `this.ctx.storage`. */
  readonly stored = new Map<string, unknown>();
  readonly ctx = {
    storage: {
      get: async (key: string) => structuredClone(this.stored.get(key)),
      put: async (key: string, value: unknown) => void this.stored.set(key, structuredClone(value)),
    },
  };

  constructor(initialState: State) {
    this.state = initialState;
  }
  setState(state: State) {
    this.state = state;
  }
  onRequest(request: Request): Response | Promise<Response> {
    this.baseRequests.push(request);
    return new Response("base", { status: 404 });
  }
  onMessage(_connection: unknown, message: unknown): void | Promise<void> {
    this.baseMessages.push(message);
  }
  onClose(connection: AGUIConnection): void {
    this.closed.push(connection.id);
  }
}

type TodoState = { todos: string[] };

/** An agent with a client tool path, a server tool that writes state, and an approval-gated tool. */
class TodoAgent extends withAGUI(FakeAgent<TodoState>) {
  model = sdk.model([turn(chunks.text("t1", "Hello!"))]);
  runs: AGUIRun<TodoState>[] = [];

  onAGUIRun(run: AGUIRun<TodoState>) {
    this.runs.push(run);
    return ai.streamText({
      model: this.model as any,
      system: run.instructions("You keep a todo list."),
      messages: run.messages,
      stopWhen: ai.stepCountIs(3),
      abortSignal: run.abortSignal,
      tools: {
        ...run.clientTools,
        add_todo: ai.tool({
          inputSchema: ai.jsonSchema({ type: "object", properties: { text: { type: "string" } } }),
          execute: async ({ text }: any) => {
            this.setState({ todos: [...this.state.todos, text] });
            return "added";
          },
        }),
      },
    });
  }
}

/** An `HttpAgent` whose requests go straight to the agent's `onRequest`. */
function httpClient(agent: TodoAgent, urls: string[] = []) {
  const client = new CloudflareAgentsHttpAgent({
    url: "https://worker.example/agents/todo-agent",
    fetch: async (url, init) => {
      urls.push(String(url));
      return agent.onRequest(new Request(url, init));
    },
  });
  const events: BaseEvent[] = [];
  client.subscribe({ onEvent: ({ event }) => void events.push(event) });
  return { client, events };
}

const user = (content: string): Message => ({ id: `u-${content}`, role: "user", content });

describe("withAGUI over HTTP", () => {
  it("serves a run at the thread's URL", async () => {
    const agent = new TodoAgent({ todos: [] });
    const urls: string[] = [];
    const { client } = httpClient(agent, urls);
    client.threadId = "thread/42";
    client.messages = [user("Hi")];

    await client.runAgent();

    expect(urls).toEqual(["https://worker.example/agents/todo-agent/thread%2F42"]);
    expect(client.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hello!" });
    expect(agent.keepAlive).toHaveBeenCalledOnce();
    expect(agent.released).toHaveBeenCalledOnce();
  });

  it("makes the agent's state the thread's shared state", async () => {
    const agent = new TodoAgent({ todos: [] });
    agent.model = sdk.model([
      turn(chunks.toolCall("tc1", "add_todo", { text: "milk" })),
      turn(chunks.text("t2", "Added milk.")),
    ]);
    const { client, events } = httpClient(agent);
    client.messages = [user("Add milk")];
    client.state = { todos: ["eggs"] };

    await client.runAgent();

    // The client's state was saved into the agent, then the tool's change streamed back.
    expect(agent.state).toEqual({ todos: ["eggs", "milk"] });
    expect(client.state).toEqual({ todos: ["eggs", "milk"] });
    expect(events.filter((e) => e.type === EventType.STATE_SNAPSHOT)).toHaveLength(1);
    expect(agent.model.prompts[0][0].content).toContain('"eggs"');
  });

  it("restores the agent's saved state for a client that has none", async () => {
    const agent = new TodoAgent({ todos: ["from storage"] });
    const { client } = httpClient(agent);
    client.messages = [user("What's on my list?")];

    await client.runAgent();

    expect(client.state).toEqual({ todos: ["from storage"] });
  });

  it("leaves other requests to the base class", async () => {
    const agent = new TodoAgent({ todos: [] });
    const response = await agent.onRequest(new Request("https://worker.example/agents/todo-agent/t1"));
    expect(response.status).toBe(404);
    expect(agent.baseRequests).toHaveLength(1);
  });

  it("rejects a malformed run", async () => {
    const agent = new TodoAgent({ todos: [] });
    const response = await agent.onRequest(
      new Request("https://worker.example/agents/todo-agent/t1", {
        method: "POST",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "t1" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("runId is required");
  });

  it("reports an agent without onAGUIRun as RUN_ERROR", async () => {
    // @ts-expect-error onAGUIRun is abstract: TypeScript already refuses this class.
    class Empty extends withAGUI(FakeAgent<{}>) {}
    const agent = new Empty({});
    const client = new CloudflareAgentsHttpAgent({
      url: "https://worker.example/agents/empty",
      fetch: async (url, init) => agent.onRequest(new Request(url, init)),
    });
    client.messages = [user("Hi")];
    const errors: BaseEvent[] = [];
    client.subscribe({ onRunErrorEvent: ({ event }) => void errors.push(event) });
    await client.runAgent();
    expect(errors).toEqual([expect.objectContaining({ code: "AGENT_ERROR" })]);
  });

  it("keeps what the server changed between runs over the client's stale copy", async () => {
    const agent = new TodoAgent({ todos: [] });
    const { client } = httpClient(agent);
    client.messages = [user("Hi")];
    client.state = { todos: ["eggs"] };
    await client.runAgent();
    expect(agent.state).toEqual({ todos: ["eggs"] });

    // A scheduled job (or another client) changes the state between runs.
    agent.setState({ todos: ["eggs", "from a schedule"] });
    client.messages.push(user("What's on my list?"));
    await client.runAgent();

    expect(agent.state).toEqual({ todos: ["eggs", "from a schedule"] });
    expect(client.state).toEqual({ todos: ["eggs", "from a schedule"] });
  });

  it("takes the client's edits made between runs", async () => {
    const agent = new TodoAgent({ todos: [] });
    const { client } = httpClient(agent);
    client.messages = [user("Hi")];
    client.state = { todos: ["eggs"] };
    await client.runAgent();

    client.state = { todos: ["eggs", "edited in the app"] };
    client.messages.push(user("What's on my list?"));
    await client.runAgent();

    expect(agent.state).toEqual({ todos: ["eggs", "edited in the app"] });
  });

  it("records paused approvals in the agent's storage and checks resumes against them", async () => {
    class RefundAgent extends withAGUI(FakeAgent<{}>) {
      model = sdk.model([
        turn(chunks.toolCall("tc1", "issue_refund", { order: "A1" })),
        turn(chunks.text("t2", "Refunded.")),
      ]);
      execute = vi.fn(async () => "refunded");
      onAGUIRun(run: AGUIRun<{}>) {
        return ai.streamText({
          model: this.model as any,
          messages: run.messages,
          stopWhen: ai.stepCountIs(3),
          tools: {
            issue_refund: ai.tool({
              inputSchema: ai.jsonSchema({ type: "object", properties: { order: { type: "string" } } }),
              needsApproval: true,
              execute: this.execute,
            }),
          },
        });
      }
    }
    const agent = new RefundAgent({});
    const client = new CloudflareAgentsHttpAgent({
      url: "https://worker.example/agents/refund-agent",
      fetch: async (url, init) => agent.onRequest(new Request(url, init)),
    });
    client.messages = [user("Refund A1")];

    await client.runAgent();
    expect(agent.stored.get("ag-ui:pending-approvals")).toEqual([
      expect.objectContaining({ toolCallId: "tc1", toolName: "issue_refund", input: { order: "A1" } }),
    ]);

    await client.runAgent({ resume: [{ interruptId: "tc1", status: "resolved", payload: { approved: true } }] });
    expect(agent.execute).toHaveBeenCalledOnce();
    expect(agent.stored.get("ag-ui:pending-approvals")).toEqual([]);
    expect(client.messages.at(-1)).toMatchObject({ role: "assistant", content: "Refunded." });
  });
});

/** A WebSocket wired to the agent's onMessage/onClose, as the Agents SDK would. */
function socketPair(agent: TodoAgent) {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    readyState = 0;
    readonly sent: string[] = [];
    readonly connection: AGUIConnection & { id: string };
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      this.connection = {
        id: `conn-${sockets.length}`,
        send: (data: string) => {
          this.dispatchEvent(new MessageEvent("message", { data }));
        },
      };
      // Like the Agents SDK, the server speaks its own protocol first.
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        this.connection.send(JSON.stringify({ type: "cf_agent_state", state: agent.state }));
      });
    }
    send(data: string) {
      this.sent.push(data);
      void agent.onMessage(this.connection, data);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      void agent.onClose(this.connection, 1000, "", true);
    }
  }
  return { FakeSocket, sockets };
}

describe("withAGUI over WebSocket", () => {
  it("runs over the agent's socket next to the Agents SDK protocol", async () => {
    const agent = new TodoAgent({ todos: [] });
    const { FakeSocket, sockets } = socketPair(agent);
    const client = new CloudflareAgentsClient({
      url: "https://worker.example/agents/todo-agent",
      threadId: "t-ws",
      WebSocket: FakeSocket as any,
    });
    client.messages = [user("Hi")];

    await client.runAgent();

    expect(sockets[0]!.url).toBe("wss://worker.example/agents/todo-agent/t-ws");
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ type: RUN_FRAME, input: { threadId: "t-ws" } });
    expect(client.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hello!" });
    expect(sockets[0]!.readyState).toBe(3);
  });

  it("passes other frames to the base class", async () => {
    const agent = new TodoAgent({ todos: [] });
    await agent.onMessage({ id: "c1", send: () => {} }, JSON.stringify({ type: "cf_agent_use_chat_request" }));
    await agent.onMessage({ id: "c1", send: () => {} }, "ping");
    expect(agent.baseMessages).toEqual([JSON.stringify({ type: "cf_agent_use_chat_request" }), "ping"]);
  });

  it("cancels a run on an abort frame from its connection", async () => {
    const agent = new TodoAgent({ todos: [] });
    agent.model = sdk.model([
      (options: any) =>
        new ReadableStream({
          start(stream) {
            stream.enqueue(chunks.start());
            stream.enqueue({ type: "text-start", id: "t1" });
            stream.enqueue({ type: "text-delta", id: "t1", delta: "Thinking" });
            options.abortSignal?.addEventListener("abort", () =>
              stream.error(new DOMException("Aborted", "AbortError")),
            );
          },
        }),
    ]);
    const frames: any[] = [];
    const connection = { id: "c1", send: (data: string) => void frames.push(JSON.parse(data)) };
    const input = { threadId: "t", runId: "r1", messages: [user("Hi")], tools: [], context: [] };

    const running = agent.onMessage(connection, JSON.stringify({ type: RUN_FRAME, input }));
    await vi.waitFor(() => expect(frames.some((f) => f.event.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true));
    // Another connection cannot cancel it.
    await agent.onMessage({ id: "c2", send: () => {} }, JSON.stringify({ type: ABORT_FRAME, runId: "r1" }));
    await agent.onMessage(connection, JSON.stringify({ type: ABORT_FRAME, runId: "r1" }));
    await running;

    expect(frames.every((f) => f.type === EVENT_FRAME && f.runId === "r1")).toBe(true);
    expect(frames.at(-1).event).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "cancelled" } });
  });

  it("reports a malformed run frame on the socket", async () => {
    const agent = new TodoAgent({ todos: [] });
    const frames: any[] = [];
    await agent.onMessage(
      { id: "c1", send: (data: string) => void frames.push(JSON.parse(data)) },
      JSON.stringify({ type: RUN_FRAME, input: { runId: "r9" } }),
    );
    expect(frames).toEqual([
      {
        type: EVENT_FRAME,
        runId: "r9",
        event: { type: EventType.RUN_ERROR, message: "threadId is required", code: "INVALID_INPUT" },
      },
    ]);
  });
});
