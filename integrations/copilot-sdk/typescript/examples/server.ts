/**
 * Multi-agent server for the GitHub Copilot SDK integration (TypeScript).
 *
 * The agent owns the native SDK session lifecycle — the server just calls
 * agent.run(input) and streams the resulting AG-UI events.
 *
 * Usage:
 *   node dist-example/server.js
 *
 * Set OPENAI_BASE_URL (and OPENAI_API_KEY) to route inference at an
 * OpenAI-compatible endpoint through the SDK's BYOK provider — that is how the
 * Dojo e2e suites drive this server against the pinned mock model server.
 * Without it the SDK uses the machine's logged-in Copilot account.
 *
 * The example binds to loopback and is unauthenticated; it is a demo, not a
 * deployment template.
 */

import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { EventEncoder } from "@ag-ui/encoder";
import type { RunAgentInput } from "@ag-ui/core";
import type { CopilotAgent, CopilotClientPort } from "../dist/index.js";

import { createAgenticChatAgent } from "./agentic_chat.js";

function createAgents(client: CopilotClientPort): Record<string, CopilotAgent> {
  return {
    agentic_chat: createAgenticChatAgent(client),
  };
}

function handleRequest(
  agents: Record<string, CopilotAgent>,
): http.RequestListener {
  return (req, res) => {
    void (async () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname.replace(/^\//, "");

      if (req.method === "GET" && path === "health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy", agents: Object.keys(agents).length }));
        return;
      }

      const agent = req.method === "POST" ? agents[path] : undefined;
      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found", availableRoutes: Object.keys(agents) }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      let input: RunAgentInput;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as RunAgentInput;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const encoder = new EventEncoder({ accept: req.headers.accept ?? "text/event-stream" });
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const subscription = agent.run(input).subscribe({
        next: (event) => res.write(encoder.encode(event)),
        error: (error: unknown) => {
          res.write(
            encoder.encode({
              type: "RUN_ERROR",
              message: error instanceof Error ? error.message : String(error),
            } as never),
          );
          res.end();
        },
        complete: () => res.end(),
      });
      res.on("close", () => subscription.unsubscribe());
    })();
  };
}

async function main(): Promise<void> {
  const baseDirectory = await mkdtemp(join(tmpdir(), "copilot-sdk-dojo-"));
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory,
    // BYOK runs bypass Copilot API auth entirely.
    useLoggedInUser: !process.env.OPENAI_BASE_URL,
  });
  await client.start();

  const agents = createAgents(client);
  const port = parseInt(process.env.PORT ?? "8028", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = http.createServer(handleRequest(agents));

  const shutdown = async (): Promise<void> => {
    server.closeAllConnections();
    server.close();
    await Promise.allSettled(Object.values(agents).map((agent) => agent.close()));
    await client.stop().catch(() => {});
    await rm(baseDirectory, { recursive: true, force: true });
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  server.listen(port, host, () => {
    console.log(`GitHub Copilot SDK (TypeScript) server running on http://${host}:${port}`);
    for (const name of Object.keys(agents)) console.log(`  POST http://${host}:${port}/${name}`);
    console.log(`  GET  http://${host}:${port}/health`);
  });
}

void main();
