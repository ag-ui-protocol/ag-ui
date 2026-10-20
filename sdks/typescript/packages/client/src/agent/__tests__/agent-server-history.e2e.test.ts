/**
 * End to end: a real HttpAgent against an in-process node:http server that
 * owns the chat history (ag-ui-protocol/ag-ui#2186), speaking SSE.
 *
 * The server follows the recommended trust rules: it stores the thread itself,
 * ignores ids it already has, accepts only `user` and `tool` messages from the
 * client, and builds the model context from its own store. A cursor it cannot
 * place is answered with RUN_ERROR HISTORY_UNAVAILABLE.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpAgent } from "../http";
import { HISTORY_CURSOR_KEY, HISTORY_UNAVAILABLE_CODE } from "../agent";
import type { HistoryMode } from "../types";
import { AgentCapabilities, EventType, Message, RunAgentInput } from "@ag-ui/core";

/** Larger than a typical turn, so full-history growth shows clearly. */
const TURN_TEXT = "x".repeat(1500);
/** The WAF limit that motivated the feature. */
const WAF_LIMIT = 8 * 1024;

interface Recorded {
  bodySize: number;
  body: RunAgentInput;
}

class HistoryServer {
  public requests: Recorded[] = [];
  /** threadId -> the server's own record of the conversation. */
  public threads = new Map<string, Message[]>();
  private server!: Server;
  private replies = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then((frames) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/agent`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<unknown[]> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const input = JSON.parse(raw.toString("utf8")) as RunAgentInput;
    this.requests.push({ bodySize: raw.byteLength, body: input });

    const { threadId, runId } = input;
    const runStarted = { type: EventType.RUN_STARTED, threadId, runId };
    const cursor = (input.forwardedProps as Record<string, unknown> | undefined)?.[
      HISTORY_CURSOR_KEY
    ];
    const stored = this.threads.get(threadId);

    if (cursor !== undefined && !stored?.some((m) => m.id === cursor)) {
      return [
        runStarted,
        { type: EventType.RUN_ERROR, message: "history unavailable", code: HISTORY_UNAVAILABLE_CODE },
      ];
    }

    const history = stored ?? [];
    const known = new Set(history.map((m) => m.id));
    for (const message of input.messages) {
      if (known.has(message.id)) continue; // never overwrite
      if (message.role !== "user" && message.role !== "tool") continue; // untrusted roles
      history.push(message);
    }
    const replyId = `a${++this.replies}`;
    history.push({ id: replyId, role: "assistant", content: `reply ${this.replies}` });
    this.threads.set(threadId, history);

    return [
      runStarted,
      { type: EventType.TEXT_MESSAGE_START, messageId: replyId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: replyId, delta: `reply ${this.replies}` },
      { type: EventType.TEXT_MESSAGE_END, messageId: replyId },
      { type: EventType.RUN_FINISHED, threadId, runId },
    ];
  }
}

const cursorOf = (input: RunAgentInput) =>
  (input.forwardedProps as Record<string, unknown> | undefined)?.[HISTORY_CURSOR_KEY];
const ids = (messages: Message[]) => messages.map((m) => m.id);

async function chat(agent: HttpAgent, turns: string[]) {
  for (const id of turns) {
    agent.addMessage({ id, role: "user", content: `${id}: ${TURN_TEXT}` });
    await agent.runAgent();
  }
}

describe("server-managed history over HTTP + SSE", () => {
  let server: HistoryServer;
  let url: string;

  beforeEach(async () => {
    server = new HistoryServer();
    url = await server.start();
  });
  afterEach(() => server.stop());

  const newAgent = (historyMode?: HistoryMode) => {
    const agent = new HttpAgent({ url, threadId: "thread-1", historyMode });
    agent.debug = false;
    return agent;
  };

  it("server mode: turns 2 and 3 carry only the new user message and the cursor", async () => {
    const agent = newAgent("server");
    await chat(agent, ["u1", "u2", "u3"]);

    const bodies = server.requests.map((r) => r.body);
    expect(bodies.map((b) => ids(b.messages))).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(bodies.map(cursorOf)).toEqual([undefined, "a1", "a2"]);

    const sizes = server.requests.map((r) => r.bodySize);
    console.info("[e2e] server mode body sizes (bytes):", sizes);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
    expect(sizes.every((size) => size < WAF_LIMIT)).toBe(true);

    expect(ids(agent.messages)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
    expect(ids(server.threads.get("thread-1")!)).toEqual(ids(agent.messages));
  });

  it("auto mode: a getCapabilities override advertising the capability enables deltas", async () => {
    const agent = newAgent("auto");
    let capabilityCalls = 0;
    agent.getCapabilities = async (): Promise<AgentCapabilities> => {
      capabilityCalls++;
      return { custom: { serverManagedHistory: true } };
    };
    await chat(agent, ["u1", "u2", "u3"]);

    expect(capabilityCalls).toBe(1);
    expect(server.requests.map((r) => ids(r.body.messages))).toEqual([["u1"], ["u2"], ["u3"]]);
    expect(server.requests.map((r) => cursorOf(r.body))).toEqual([undefined, "a1", "a2"]);
    console.info(
      "[e2e] auto mode body sizes (bytes):",
      server.requests.map((r) => r.bodySize),
    );
  });

  it("HISTORY_UNAVAILABLE triggers exactly one retry carrying the full history", async () => {
    const agent = newAgent("server");
    const runErrors: string[] = [];
    const runStarts: string[] = [];
    agent.subscribe({
      onRunStartedEvent: ({ event }) => {
        runStarts.push(event.runId);
      },
      onRunErrorEvent: ({ event }) => {
        runErrors.push(event.message);
      },
    });
    await chat(agent, ["u1", "u2"]);

    // The server loses the thread (restart, eviction, another region).
    server.threads.clear();
    await chat(agent, ["u3"]);

    const bodies = server.requests.map((r) => r.body);
    expect(bodies).toHaveLength(4);
    // Turn 3: the delta is refused...
    expect(ids(bodies[2].messages)).toEqual(["u3"]);
    expect(cursorOf(bodies[2])).toBe("a2");
    // ...and retried once with everything, no cursor.
    expect(ids(bodies[3].messages)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(cursorOf(bodies[3])).toBeUndefined();
    expect(bodies[3].runId).toBe(bodies[2].runId);
    // Subscribers saw three clean runs.
    expect(runStarts).toHaveLength(3);
    expect(runErrors).toEqual([]);
    // The server rebuilt the thread from trusted roles only.
    expect(ids(server.threads.get("thread-1")!)).toEqual(["u1", "u2", "u3", "a3"]);

    // Turn 4 is a delta again.
    await chat(agent, ["u4"]);
    expect(ids(server.requests[4].body.messages)).toEqual(["u4"]);
    expect(cursorOf(server.requests[4].body)).toBe("a3");
    console.info(
      "[e2e] fallback body sizes (bytes):",
      server.requests.map((r) => r.bodySize),
    );
  });

  it("default mode still sends the full history every turn", async () => {
    const agent = newAgent();
    await chat(agent, ["u1", "u2", "u3"]);

    const bodies = server.requests.map((r) => r.body);
    expect(bodies.map((b) => ids(b.messages))).toEqual([
      ["u1"],
      ["u1", "a1", "u2"],
      ["u1", "a1", "u2", "a2", "u3"],
    ]);
    expect(bodies.every((b) => cursorOf(b) === undefined)).toBe(true);
    const sizes = server.requests.map((r) => r.bodySize);
    console.info("[e2e] full mode body sizes (bytes):", sizes);
    expect(sizes[2]).toBeGreaterThan(sizes[0] * 2.5);
  });
});
