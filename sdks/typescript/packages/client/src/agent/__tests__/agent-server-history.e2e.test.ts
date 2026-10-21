/**
 * End to end: a real HttpAgent against an in-process node:http server that
 * owns the chat history (ag-ui-protocol/ag-ui#2186), speaking SSE.
 *
 * The server follows the recommended trust rules: it stores the thread itself,
 * ignores ids it already has, accepts only `user` messages and `tool` results
 * for calls it has pending, uses system and developer messages without storing
 * them, and builds the model context from its own store. A cursor it cannot
 * place is answered with RUN_ERROR HISTORY_UNAVAILABLE. A request without a
 * cursor imports the client's history in the client's order: user messages and
 * pending tool results from the client, anything else only from its own store.
 *
 * A user message starting with "mcp:" or "client:" makes the server ask for
 * the `mcp_lookup` or `client_lookup` tool instead of replying with text.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Observable } from "rxjs";
import { HttpAgent } from "../http";
import { HISTORY_CURSOR_KEY, HISTORY_UNAVAILABLE_CODE } from "../agent";
import type { HistoryMode } from "../types";
import { AgentCapabilities, BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";

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
  /** threadId -> tool call ids the server asked for and has no result for. */
  private pending = new Map<string, Set<string>>();
  private server!: Server;
  private replies = 0;
  private toolCalls = 0;

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
    const stored = this.threads.get(threadId) ?? [];
    const pending = this.pending.get(threadId) ?? new Set<string>();
    this.pending.set(threadId, pending);

    if (cursor !== undefined && !stored.some((m) => m.id === cursor)) {
      return [
        runStarted,
        {
          type: EventType.RUN_ERROR,
          message: "history unavailable",
          code: HISTORY_UNAVAILABLE_CODE,
        },
      ];
    }

    // With a cursor the stored thread is extended; without one it is
    // re-imported in the client's order, trusting only what the rules allow.
    const own = new Map(stored.map((m) => [m.id, m]));
    const history: Message[] = cursor !== undefined ? [...stored] : [];
    const known = new Set(history.map((m) => m.id));
    for (const message of input.messages) {
      if (known.has(message.id)) continue; // never overwrite
      if (message.role === "user") {
        history.push(message);
      } else if (message.role === "tool" && pending.has(message.toolCallId)) {
        pending.delete(message.toolCallId);
        history.push(message);
      } else if (cursor === undefined && own.has(message.id)) {
        history.push(own.get(message.id)!); // its own stored copy, not the client's
      } else {
        continue; // system, developer, client-authored assistant: not stored
      }
      known.add(message.id);
    }

    const replyId = `a${++this.replies}`;
    const last = history[history.length - 1];
    const ask =
      last?.role === "user" && typeof last.content === "string"
        ? /^(mcp|client):/.exec(last.content)?.[1]
        : undefined;
    const frames: unknown[] = [runStarted];
    if (ask) {
      const toolCallId = `tc${++this.toolCalls}`;
      const toolCallName = `${ask}_lookup`;
      pending.add(toolCallId);
      history.push({
        id: replyId,
        role: "assistant",
        toolCalls: [
          { id: toolCallId, type: "function", function: { name: toolCallName, arguments: "{}" } },
        ],
      });
      frames.push(
        { type: EventType.TOOL_CALL_START, toolCallId, toolCallName, parentMessageId: replyId },
        { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" },
        { type: EventType.TOOL_CALL_END, toolCallId },
      );
    } else {
      history.push({ id: replyId, role: "assistant", content: `reply ${this.replies}` });
      frames.push(
        { type: EventType.TEXT_MESSAGE_START, messageId: replyId, role: "assistant" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: replyId,
          delta: `reply ${this.replies}`,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: replyId },
      );
    }
    this.threads.set(threadId, history);
    frames.push({ type: EventType.RUN_FINISHED, threadId, runId });
    return frames;
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

/**
 * An MCP-style middleware: when the agent asks for `mcp_lookup`, it runs the
 * tool itself and continues with a second `next.run`, presenting both as one
 * run (the first RUN_FINISHED and the second RUN_STARTED are hidden).
 */
function mcpStyleMiddleware(seen: string[][]) {
  return (
    input: RunAgentInput,
    next: { run(input: RunAgentInput): Observable<BaseEvent>; messages: Message[] },
  ) =>
    new Observable<BaseEvent>((out) => {
      seen.push(ids(input.messages));
      let owner: Message | undefined;
      const first = next.run(input).subscribe({
        next: (event) => {
          if (event.type === EventType.TOOL_CALL_START) {
            const start = event as BaseEvent & {
              toolCallId: string;
              toolCallName: string;
              parentMessageId: string;
            };
            if (start.toolCallName === "mcp_lookup") {
              owner = {
                id: start.parentMessageId,
                role: "assistant",
                toolCalls: [
                  {
                    id: start.toolCallId,
                    type: "function",
                    function: { name: start.toolCallName, arguments: "{}" },
                  },
                ],
              };
            }
          }
          if (event.type === EventType.RUN_FINISHED && owner) return;
          out.next(event);
        },
        error: (error) => out.error(error),
        complete: () => {
          if (!owner) return out.complete();
          const toolCallId = owner.role === "assistant" ? owner.toolCalls![0].id : "";
          const result: Message = {
            id: `result-${toolCallId}`,
            role: "tool",
            toolCallId,
            content: "sunny",
          };
          // Like the MCP middleware, keep the agent's own history in step.
          next.messages.push(result);
          const messages = [...input.messages, owner, result];
          seen.push(ids(messages));
          next.run({ ...input, messages }).subscribe({
            next: (event) => {
              if (event.type !== EventType.RUN_STARTED) out.next(event);
            },
            error: (error) => out.error(error),
            complete: () => out.complete(),
          });
        },
      });
      return () => first.unsubscribe();
    });
}

describe("server-managed history over HTTP + SSE", () => {
  let server: HistoryServer;
  let url: string;

  beforeEach(async () => {
    server = new HistoryServer();
    url = await server.start();
  });
  afterEach(() => server.stop());

  const newAgent = (historyMode?: HistoryMode, initialMessages?: Message[]) => {
    const agent = new HttpAgent({ url, threadId: "thread-1", historyMode, initialMessages });
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

  describe("a conversation with instructions, tools, a middleware and an edit", () => {
    const system: Message = { id: "sys", role: "system", content: "Answer briefly." };

    /**
     * Turn by turn: plain text; an MCP tool the middleware runs and continues
     * (two requests); a client tool call; its client-side result; an edit of
     * the first user message followed by a new turn; one more turn.
     */
    async function converse(agent: HttpAgent, middlewareSaw: string[][]) {
      agent.use(mcpStyleMiddleware(middlewareSaw));
      const turnRequests: number[] = [];
      const turn = async (message?: Message) => {
        if (message) agent.addMessage(message);
        const before = server.requests.length;
        await agent.runAgent();
        turnRequests.push(server.requests.length - before);
      };
      const say = (id: string, text: string): Message => ({
        id,
        role: "user",
        content: `${text} ${TURN_TEXT}`,
      });

      await turn(say("u1", "hello"));
      await turn(say("u2", "mcp: weather?"));
      await turn(say("u3", "client: location?"));
      const pendingCall = agent.messages.find((m) => m.id === "a4");
      const toolCallId = pendingCall?.role === "assistant" ? pendingCall.toolCalls![0].id : "";
      await turn({ id: "t3", role: "tool", toolCallId, content: "Berlin" });
      agent.messages = agent.messages.map((m) => (m.id === "u1" ? say("u1", "hello, edited") : m));
      await turn(say("u5", "and tomorrow?"));
      await turn(say("u6", "thanks"));
      return turnRequests;
    }

    const bodySizesPerTurn = (turnRequests: number[]) => {
      let index = 0;
      return turnRequests.map((count) => {
        const sizes = server.requests.slice(index, index + count).map((r) => r.bodySize);
        index += count;
        return sizes.reduce((a, b) => a + b, 0);
      });
    };

    it("server mode: middlewares see everything, the wire carries the delta", async () => {
      const middlewareSaw: string[][] = [];
      const agent = newAgent("server", [system]);
      const turnRequests = await converse(agent, middlewareSaw);
      const bodies = server.requests.map((r) => r.body);

      expect(turnRequests).toEqual([1, 2, 1, 1, 1, 1]);
      expect(bodies.map((b) => ids(b.messages))).toEqual([
        ["sys", "u1"],
        ["sys", "u2"],
        // MCP-style continuation: the still unconfirmed u2, the owner, the result.
        ["sys", "u2", "a2", "result-tc1"],
        ["sys", "u3"],
        // Client tool result: the confirmed owner travels with it.
        ["sys", "a4", "t3"],
        // u1 was edited: one full upload without a cursor. The MCP result
        // never reached agent.messages (the run's reducer overwrites the
        // middleware's push), so it is not part of the client's history.
        ["sys", "u1", "a1", "u2", "a2", "a3", "u3", "a4", "t3", "a5", "u5"],
        // The delta resumes.
        ["sys", "u6"],
      ]);
      expect(bodies.map(cursorOf)).toEqual([undefined, "a1", "a1", "a3", "a4", undefined, "a6"]);

      // Middlewares saw the full history on every call, continuation included.
      expect(middlewareSaw.map((seen) => seen.length)).toEqual([2, 4, 6, 7, 9, 11, 13]);
      expect(middlewareSaw[5]).toEqual([
        "sys",
        "u1",
        "a1",
        "u2",
        "a2",
        "a3",
        "u3",
        "a4",
        "t3",
        "a5",
        "u5",
      ]);

      // The server imported the edited history and stored no instructions.
      const thread = server.threads.get("thread-1")!;
      expect(thread.find((m) => m.id === "u1")).toMatchObject({
        content: expect.stringContaining("edited"),
      });
      expect(thread.some((m) => m.role === "system")).toBe(false);
      expect(ids(thread)).toEqual(ids(agent.messages).filter((id) => id !== "sys"));

      const sizes = bodySizesPerTurn(turnRequests);
      console.info("[e2e] conversation, server mode, body bytes per turn:", sizes);
      expect(server.requests.filter((_, i) => i !== 5).every((r) => r.bodySize < WAF_LIMIT)).toBe(
        true,
      );
    });

    it("full mode: the same conversation, for comparison", async () => {
      const middlewareSaw: string[][] = [];
      const agent = newAgent("full", [system]);
      const turnRequests = await converse(agent, middlewareSaw);

      expect(server.requests.every((r) => cursorOf(r.body) === undefined)).toBe(true);
      expect(server.requests.map((r) => r.body.messages.length)).toEqual(
        middlewareSaw.map((seen) => seen.length),
      );
      console.info(
        "[e2e] conversation, full mode, body bytes per turn:",
        bodySizesPerTurn(turnRequests),
      );
    });
  });
});
