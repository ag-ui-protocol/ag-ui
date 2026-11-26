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
 * The example binds to all interfaces (HOST=0.0.0.0, for container deploys)
 * and is unauthenticated; it is a demo, not a deployment template. Set
 * HOST=127.0.0.1 on a shared network.
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
import { createAgenticChatReasoningAgent } from "./agentic_chat_reasoning.js";
import { createAgenticChatMultimodalAgent } from "./agentic_chat_multimodal.js";
import { createBackendToolRenderingAgent } from "./backend_tool_rendering.js";
import { createHumanInTheLoopAgent } from "./human_in_the_loop.js";
import { createToolBasedGenerativeUIAgent } from "./tool_based_generative_ui.js";
import { createSharedStateAgent } from "./shared_state.js";
import { createAgenticGenerativeUIAgent } from "./agentic_generative_ui.js";
import { createPredictiveStateUpdatesAgent } from "./predictive_state_updates.js";
import { createInterruptAgent } from "./interrupt.js";
import { createDeepagentsSubagentsAgent } from "./deepagents_subagents.js";
import { createSubgraphsAgent } from "./subgraphs.js";

function createAgents(client: CopilotClientPort): Record<string, CopilotAgent> {
  return {
    agentic_chat: createAgenticChatAgent(client),
    agentic_chat_reasoning: createAgenticChatReasoningAgent(client),
    agentic_chat_multimodal: createAgenticChatMultimodalAgent(client),
    backend_tool_rendering: createBackendToolRenderingAgent(client),
    human_in_the_loop: createHumanInTheLoopAgent(client),
    tool_based_generative_ui: createToolBasedGenerativeUIAgent(client),
    shared_state: createSharedStateAgent(client),
    agentic_generative_ui: createAgenticGenerativeUIAgent(client),
    predictive_state_updates: createPredictiveStateUpdatesAgent(client),
    interrupt: createInterruptAgent(client),
    deepagents_subagents: createDeepagentsSubagentsAgent(client),
    subgraphs: createSubgraphsAgent(client),
  };
}

function handleRequest(
  agents: Record<string, CopilotAgent>,
): http.RequestListener {
  return (req, res) => {
    (async () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request URL" }));
        return;
      }
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

      // Observer callbacks must not throw: RxJS rethrows them asynchronously,
      // which would crash the process. An unencodable event drops the stream.
      let subscription: { unsubscribe(): void } | undefined;
      const send = (event: Parameters<typeof encoder.encode>[0]): boolean => {
        if (res.destroyed) return false;
        try {
          res.write(encoder.encode(event));
          return true;
        } catch {
          subscription?.unsubscribe();
          res.destroy();
          return false;
        }
      };
      subscription = agent.run(input).subscribe({
        next: (event) => void send(event),
        error: (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (send({ type: "RUN_ERROR", message } as never)) res.end();
        },
        complete: () => {
          if (!res.destroyed) res.end();
        },
      });
      if (res.destroyed) subscription.unsubscribe();
      res.on("close", () => subscription?.unsubscribe());
    })().catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
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
  const port = parseInt(process.env.PORT ?? "8032", 10);
  const host = process.env.HOST ?? "0.0.0.0";
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
