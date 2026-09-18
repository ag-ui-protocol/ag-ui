import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { CopilotClient } from "@github/copilot-sdk";
import { RunAgentInputSchema } from "@ag-ui/core";
import { CopilotAdapter, CopilotAdapterError, type CopilotClientPort } from "../dist/index.js";

const FRONTEND_TOOLS = new Set(["browser_nonce", "browser_confirm", "change_background"]);
const ALLOWED_ORIGINS = new Set([
  "http://localhost:9999", "http://127.0.0.1:9999",
  "http://localhost:3100", "http://127.0.0.1:3100",
]);

export function serverSettings(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.COPILOT_DEMO_MODE ?? "live";
  if (mode !== "fixture" && mode !== "live") throw new Error("COPILOT_DEMO_MODE must be live or fixture");
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "localhost" && !isIP(host)) throw new Error("HOST must be an IP address or localhost");
  const port = Number(env.PORT ?? "8028");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const model = env.COPILOT_MODEL ?? "gpt-5.4-mini";
  if (!model.trim()) throw new Error("Invalid COPILOT_MODEL");
  return { mode, host, port, model } as const;
}

// Explicit CI fixture: exercises the adapter without invoking a model or runtime.
export const fixtureClient: CopilotClientPort = {
  async createSession(config) {
    return {
      sessionId: `fixture-${randomUUID()}`,
      async send() {
        const messageId = randomUUID();
        const envelope = () => ({ id: randomUUID(), timestamp: new Date().toISOString(), parentId: null });
        config.onEvent?.({ ...envelope(), ephemeral: true, type: "assistant.message_start", data: { messageId } });
        for (const deltaContent of ["A synthetic ", "Copilot SDK fixture ", "says hello."]) {
          config.onEvent?.({ ...envelope(), ephemeral: true, type: "assistant.message_delta", data: { messageId, deltaContent } });
          await setTimeout(20);
        }
        config.onEvent?.({
          ...envelope(), type: "assistant.message",
          data: { messageId, content: "A synthetic Copilot SDK fixture says hello." },
        });
        config.onEvent?.({ ...envelope(), ephemeral: true, type: "session.idle", data: {} });
        return messageId;
      },
      async abort() {},
      async disconnect() {},
      rpc: { tools: { async handlePendingToolCall() { throw new Error("Text fixture does not request tools"); } } },
    };
  },
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new CopilotAdapterError("Content-Type must be application/json", 415);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1024 * 1024) {
      request.resume();
      throw new CopilotAdapterError("Request body too large", 413);
    }
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CopilotAdapterError("Malformed JSON", 400); }
}

export function createDojoServer(adapter: CopilotAdapter, mode: "fixture" | "live", host = "127.0.0.1") {
  const active = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    active.add(controller);
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", abort);
    response.once("close", abort);
    let stream: ReturnType<CopilotAdapter["stream"]> | undefined;
    let terminal = false;
    try {
      const authority = request.headers.host ?? "";
      const hostname = authority.match(/^(\[[\da-f:]+\]|[\da-z.-]+)(?::\d+)?$/i)?.[1]?.replace(/^\[|\]$/g, "");
      if (!hostname || !["localhost", "127.0.0.1", "::1", host, request.socket.localAddress].includes(hostname)) {
        throw new CopilotAdapterError("Host not allowed", 403);
      }
      const origin = request.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        throw new CopilotAdapterError("Origin not allowed", 403);
      }
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }).end();
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ status: "ready", sdk: "typescript", mode, synthetic: mode === "fixture" }));
        return;
      }
      if (request.method === "POST" && (request.url === "/agent/cancel" || request.url === "/cancel")) {
        const value = await readBody(request);
        if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== 1 || !("threadId" in value) || typeof value.threadId !== "string") {
          throw new CopilotAdapterError("Expected only a threadId string", 400);
        }
        response.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ cancelled: await adapter.cancelThread(value.threadId) }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/agent") throw new CopilotAdapterError("Not found", 404);
      const parsed = RunAgentInputSchema.safeParse(await readBody(request));
      if (!parsed.success) throw new CopilotAdapterError("Invalid RunAgentInput", 400);
      if (parsed.data.tools.some((tool) => !FRONTEND_TOOLS.has(tool.name))) {
        throw new CopilotAdapterError("Only registered demo frontend declarations are allowed", 403);
      }
      stream = adapter.stream(parsed.data, { signal: controller.signal });
      let next = await stream.next();
      if (controller.signal.aborted) return;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" });
      while (!next.done) {
        terminal = next.value.type === "RUN_FINISHED" || next.value.type === "RUN_ERROR";
        if (!response.write(`data: ${JSON.stringify(next.value)}\n\n`)) {
          await once(response, "drain", { signal: controller.signal });
        }
        next = await stream.next();
      }
      response.end();
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(error instanceof CopilotAdapterError ? error.status : 500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: error instanceof CopilotAdapterError ? error.message : "Internal server error" }));
      } else if (!response.writableEnded && !response.destroyed) {
        response.end(terminal ? undefined : 'data: {"type":"RUN_ERROR","message":"Transport failure"}\n\n');
      }
    } finally {
      controller.abort();
      try { await stream?.return(undefined); }
      catch { console.error("Failed to close an AG-UI stream"); }
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
      active.delete(controller);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await adapter.close();
    },
  };
}

async function main() {
  const { mode, host: hostname, port, model } = serverSettings();
  const baseDirectory = mode === "live"
    ? resolve(fileURLToPath(new URL("../", import.meta.url)), ".copilot-sdk-runtime", randomUUID())
    : undefined;
  if (baseDirectory) await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
  const client = baseDirectory ? new CopilotClient({ mode: "empty", baseDirectory, useLoggedInUser: true }) : undefined;
  const cleanup = async () => {
    try { await client?.stop(); }
    finally { if (baseDirectory) await rm(baseDirectory, { recursive: true, force: true }); }
  };
  let host: ReturnType<typeof createDojoServer> | undefined;
  try {
    if (client) {
      await client.start();
      if (!(await client.getAuthStatus()).isAuthenticated) throw new Error("Native Copilot authentication required");
      const models = new Set((await client.listModels()).map((entry) => entry.id));
      if (!models.has(model)) throw new Error(`Model unavailable: ${model}`);
    }
    host = createDojoServer(new CopilotAdapter({
      client: client ?? fixtureClient, model,
      sessionConfig: {
        enableConfigDiscovery: false, enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false,
        enableSkills: false, infiniteSessions: { enabled: false },
        hooks: {
          onPreToolUse: ({ toolName }) => ({
            permissionDecision: FRONTEND_TOOLS.has(toolName) ? "allow" : "deny",
          }),
        },
        onPermissionRequest: (request) => request.kind === "custom-tool" &&
          FRONTEND_TOOLS.has(request.toolName) && !request.managedApprovalRequired
          ? { kind: "approve-once" } : { kind: "reject" },
      },
    }), mode, hostname);
    host.server.listen(port, hostname);
    await once(host.server, "listening");
  } catch (error) {
    try { await host?.close(); } finally { await cleanup(); }
    throw error;
  }
  console.log(`${mode === "fixture" ? "SYNTHETIC fixture" : "Native Copilot"}: http://${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}/agent${mode === "live" ? ` (configured model: ${model})` : ""}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await host?.close(); } finally { await cleanup(); }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
