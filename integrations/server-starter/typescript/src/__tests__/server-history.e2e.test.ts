/**
 * Cross-component e2e for server-managed history (prototype for
 * ag-ui-protocol/ag-ui#2186): a real `@ag-ui/client` agent against the Python
 * reference server in `integrations/server-starter/python/examples`.
 *
 * Opt-in, since it needs `uv` and a built `@ag-ui/client`:
 *
 * - `SERVER_HISTORY_E2E=1` starts the reference server with `uv` on a free
 *   port (and restarts it once to exercise the HISTORY_UNAVAILABLE fallback);
 * - `SERVER_HISTORY_E2E_URL=http://host:port/server-history` uses a server
 *   that is already running (the restart step is skipped).
 *
 * The assertions accept the planned client behaviours: an owning assistant
 * message next to a tool result, and system messages on every run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message, RunAgentInput, Tool } from "@ag-ui/core";
import { ServerStarterAgent } from "../index";

const CURSOR_KEY = "ag-ui:historyCursor";
const PYTHON_DIR = path.resolve(__dirname, "../../../python/examples");
const EXTERNAL_URL = process.env.SERVER_HISTORY_E2E_URL;
const ENABLED = Boolean(EXTERNAL_URL) || process.env.SERVER_HISTORY_E2E === "1";

const CONFIRM_TOOL: Tool = {
  name: "confirm",
  description: "Ask the user to confirm an action.",
  parameters: { type: "object", properties: { question: { type: "string" } } },
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });

async function waitForServer(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/capabilities`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs} ms`);
}

/** Runs the reference server with uv, in its own process group. */
class ReferenceServer {
  private child?: ChildProcess;
  readonly url: string;

  constructor(private readonly port: number) {
    this.url = `http://127.0.0.1:${port}/server-history`;
  }

  async start() {
    const child = spawn(
      "uv",
      [
        "run",
        "uvicorn",
        "example_server:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
      ],
      { cwd: PYTHON_DIR, detached: true, stdio: "ignore" },
    );
    this.child = child;
    // Fail fast when uv is missing or the server exits (a port clash, say)
    // instead of waiting for the readiness timeout.
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (error) =>
        reject(new Error(`Could not start uv: ${error.message}`)),
      );
      child.once("exit", (code, signal) =>
        reject(
          new Error(
            `Reference server exited early (code ${code}, signal ${signal})`,
          ),
        ),
      );
    });
    await Promise.race([waitForServer(this.url), failed]);
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid, "SIGTERM");
    await exited;
  }
}

interface Turn {
  body: RunAgentInput;
  bytes: number;
  reply: string;
}

/** A chat client whose request bodies are captured from its fetch. */
class Chat {
  readonly agent: ServerStarterAgent;
  readonly requests: string[] = [];
  readonly system: Message;

  constructor(url: string, historyMode: "server" | "full" | "auto") {
    const threadId = randomUUID();
    this.system = {
      id: `sys-${threadId}`,
      role: "system",
      content: "Answer briefly.",
    };
    this.agent = new ServerStarterAgent({
      url,
      threadId,
      historyMode,
      fetch: (input, init) => {
        if (init?.method === "POST") this.requests.push(String(init.body));
        return fetch(input, init);
      },
    });
  }

  /** Sends one turn and returns what the last request carried. */
  async send(add: Message | undefined, tools: Tool[] = []): Promise<Turn> {
    // The app owns the instructions. A server builds MESSAGES_SNAPSHOT from
    // its store and never stores system messages, and the client reducer
    // currently drops local messages a snapshot omits, so the app re-adds its
    // system message when it is gone. This workaround becomes unnecessary once
    // the client snapshot-reducer fix (preserving local system and developer
    // messages in server mode) lands. It assigns `messages` directly because
    // setMessages() treats a replaced history as divergence and resets the
    // confirmations.
    if (!this.agent.messages.some((m) => m.id === this.system.id)) {
      this.agent.messages = [{ ...this.system }, ...this.agent.messages];
    }
    if (add) this.agent.addMessage(add);
    const before = this.requests.length;
    await this.agent.runAgent({ tools });
    expect(this.requests.length).toBeGreaterThan(before);
    const raw = this.requests[this.requests.length - 1];
    const last = this.agent.messages[this.agent.messages.length - 1];
    return {
      body: JSON.parse(raw) as RunAgentInput,
      bytes: Buffer.byteLength(raw),
      reply: typeof last?.content === "string" ? last.content : "",
    };
  }

  lastMessageId(): string {
    return this.agent.messages[this.agent.messages.length - 1].id;
  }

  pendingToolCallId(): string {
    const owner = [...this.agent.messages]
      .reverse()
      .find((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0);
    if (owner?.role !== "assistant" || !owner.toolCalls)
      throw new Error("no tool call");
    return owner.toolCalls[0].id;
  }
}

const user = (content: string): Message => ({
  id: randomUUID(),
  role: "user",
  content,
});

const replyPattern = (
  turn: number,
  users: number,
  tools: number,
  instructions = "[01]",
) =>
  new RegExp(
    `^Turn ${turn}: ${users} user messages, ${tools} tool results in server context; instructions: ${instructions}\\.$`,
  );

/**
 * The messages of a delta upload with the always-sent parts removed: system
 * and developer messages, and an assistant message that owns a tool result in
 * the same upload.
 */
function deltaCore(body: RunAgentInput): Message[] {
  const answered = new Set(
    body.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
  );
  return body.messages.filter((m) => {
    if (m.role === "system" || m.role === "developer") return false;
    if (m.role === "assistant") {
      const owns = (m.toolCalls ?? []).some((call) => answered.has(call.id));
      expect(owns, `unexpected assistant message ${m.id} in a delta`).toBe(
        true,
      );
      return false;
    }
    return true;
  });
}

const historyBytes = (body: RunAgentInput) =>
  Buffer.byteLength(JSON.stringify(body.messages));

/** The four-turn conversation both modes go through, including a frontend tool round trip. */
async function converse(chat: Chat) {
  const sent: Message[] = [];
  const cursors: (string | undefined)[] = [];
  const turns: Turn[] = [];
  const step = async (message: Message, tools: Tool[] = []) => {
    cursors.push(turns.length === 0 ? undefined : chat.lastMessageId());
    sent.push(message);
    turns.push(await chat.send(message, tools));
  };

  await step(
    user("Hello, I would like to order a kettle grill for the garden."),
  );
  await step(user("Please confirm the order before you place it."), [
    CONFIRM_TOOL,
  ]);
  await step(
    {
      id: randomUUID(),
      role: "tool",
      toolCallId: chat.pendingToolCallId(),
      content: JSON.stringify({ confirmed: true }),
    },
    [CONFIRM_TOOL],
  );
  await step(user("Thanks, that is all for today."));
  return { sent, cursors, turns };
}

describe.skipIf(!ENABLED)(
  "server-managed history against the reference server",
  () => {
    let server: ReferenceServer | undefined;
    let url: string;

    beforeAll(async () => {
      if (EXTERNAL_URL) {
        url = EXTERNAL_URL.replace(/\/+$/, "");
        await waitForServer(url);
        return;
      }
      server = new ReferenceServer(await freePort());
      await server.start();
      url = server.url;
    }, 90_000);

    afterAll(async () => {
      await server?.stop();
    });

    it("uploads only new messages plus the cursor, and the server answers from its store", async () => {
      const serverChat = new Chat(url, "auto");
      const fullChat = new Chat(url, "full");

      const serverRun = await converse(serverChat);
      const fullRun = await converse(fullChat);
      expect(serverChat.agent.usesServerHistory).toBe(true);

      // Turn 1: nothing is confirmed yet, so the full history without a cursor.
      const first = serverRun.turns[0].body;
      expect(first.forwardedProps?.[CURSOR_KEY]).toBeUndefined();
      expect(first.messages.map((m) => m.role)).toEqual(["system", "user"]);

      // Turns 2 to 4: the cursor names the last message of the previous run's
      // snapshot, and only the new message travels (plus the parts a server
      // mode client always sends).
      for (let i = 1; i < 4; i++) {
        const body = serverRun.turns[i].body;
        expect(body.forwardedProps?.[CURSOR_KEY]).toBe(serverRun.cursors[i]);
        expect(deltaCore(body).map((m) => m.id)).toEqual([
          serverRun.sent[i].id,
        ]);
      }

      // The server's counts include messages the request did not carry, so the
      // context came from its store. Instructions are counted per request.
      // Full mode always uploads the system message. In server mode the client
      // on this branch withholds the already confirmed system message, so
      // turns 2 to 4 report 0 or 1 instructions; once the client always sends
      // system messages (contract decision 2) this becomes exactly 1.
      const counts: [number, number, number][] = [
        [1, 1, 0],
        [2, 2, 0],
        [3, 2, 1],
        [4, 3, 1],
      ];
      counts.forEach(([turn, users, tools], i) => {
        expect(fullRun.turns[i].reply).toMatch(
          replyPattern(turn, users, tools, "1"),
        );
        expect(serverRun.turns[i].reply).toMatch(
          replyPattern(turn, users, tools, i === 0 ? "1" : "[01]"),
        );
      });
      expect(
        deltaCore(serverRun.turns[3].body).filter((m) => m.role === "user"),
      ).toHaveLength(1);

      // Body sizes stay flat in server mode and grow in full mode. Turns 2 and 3
      // also declare the frontend tool, so the history itself is measured as
      // the bytes of `messages`.
      const serverBytes = serverRun.turns.map((t) => t.bytes);
      const fullBytes = fullRun.turns.map((t) => t.bytes);
      const serverHistory = serverRun.turns.map((t) => historyBytes(t.body));
      const fullHistory = fullRun.turns.map((t) => historyBytes(t.body));
      const row = (cells: (string | number)[]) =>
        cells.map((c) => String(c).padEnd(14)).join("");
      console.log(
        [
          row(["turn", "server body", "full body", "server msgs", "full msgs"]),
          ...serverBytes.map((_, i) =>
            row([
              i + 1,
              serverBytes[i],
              fullBytes[i],
              serverHistory[i],
              fullHistory[i],
            ]),
          ),
        ].join("\n"),
      );
      // Both user-only turns weigh the same in server mode; the history does
      // not accumulate. Every delta stays well under 1 KB.
      expect(Math.abs(serverHistory[3] - serverHistory[1])).toBeLessThan(150);
      for (const bytes of serverHistory) expect(bytes).toBeLessThan(1024);
      for (let i = 1; i < 4; i++)
        expect(fullHistory[i]).toBeGreaterThan(fullHistory[i - 1]);
      expect(serverBytes[3] * 2).toBeLessThan(fullBytes[3]);
    }, 60_000);

    it.skipIf(Boolean(EXTERNAL_URL))(
      "retries once with full history when the server lost the thread",
      async () => {
        const chat = new Chat(url, "server");
        await chat.send(user("Hello, I would like to order a kettle grill."));
        await chat.send(user("Make it the large one."));
        const cursor = chat.lastMessageId();

        // The in-memory store is gone after a restart.
        await server!.stop();
        await server!.start();

        const before = chat.requests.length;
        const turn = await chat.send(user("And add a cover, please."));
        const bodies = chat.requests
          .slice(before)
          .map((raw) => JSON.parse(raw) as RunAgentInput);
        expect(bodies).toHaveLength(2);
        expect(bodies[0].forwardedProps?.[CURSOR_KEY]).toBe(cursor);
        expect(bodies[1].forwardedProps?.[CURSOR_KEY]).toBeUndefined();
        expect(
          bodies[1].messages.filter((m) => m.role === "user"),
        ).toHaveLength(3);

        // Fresh-start policy: only the resent user messages are kept, resent
        // assistant turns are dropped.
        expect(turn.reply).toMatch(replyPattern(1, 3, 0, "1"));
        console.log(
          `fallback: delta ${Buffer.byteLength(chat.requests[before])} bytes refused, ` +
            `full retry ${Buffer.byteLength(chat.requests[before + 1])} bytes accepted: ${turn.reply}`,
        );
      },
      120_000,
    );
  },
);
