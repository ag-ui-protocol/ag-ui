/**
 * Multi-agent server for the OpenAI Agents JS integration (TypeScript).
 *
 * The adapter manages the SDK lifecycle internally — the server just calls
 * `adapter.run(input)` and streams the resulting AG-UI events as SSE.
 *
 * Usage (against a LiteLLM-compatible proxy):
 *   OPENAI_API_KEY=sk-xxx OPENAI_BASE_URL=https://litellm.example.com/v1 \
 *     pnpm dev:examples
 *
 * Or against the OpenAI cloud:
 *   OPENAI_API_KEY=sk-xxx pnpm dev:examples
 */

import http from "node:http";
import { EventEncoder } from "@ag-ui/encoder";
import type { RunAgentInput } from "@ag-ui/core";
import type { OpenAIAgentsAdapter } from "../src";

import { createAgenticChatAdapter } from "./agentic_chat";
import { createBackendToolAdapter } from "./backend_tool_rendering";
import { createSharedStateAdapter } from "./shared_state";
import { createHumanInTheLoopAdapter } from "./human_in_the_loop";
import { createToolBasedGenerativeUiAdapter } from "./tool_based_generative_ui";

const adapters: Record<string, OpenAIAgentsAdapter> = {
  agentic_chat: createAgenticChatAdapter(),
  backend_tool_rendering: createBackendToolAdapter(),
  shared_state: createSharedStateAdapter(),
  human_in_the_loop: createHumanInTheLoopAdapter(),
  tool_based_generative_ui: createToolBasedGenerativeUiAdapter(),
};

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\//, "");

  if (req.method === "GET" && path === "health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        agents: Object.keys(adapters).length,
      }),
    );
    return;
  }

  if (req.method === "POST" && adapters[path]) {
    const adapter = adapters[path];

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf-8");

    let inputData: RunAgentInput;
    try {
      inputData = JSON.parse(body) as RunAgentInput;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const encoder = new EventEncoder({
      accept: req.headers.accept ?? "text/event-stream",
    });

    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    adapter.run(inputData).subscribe({
      next: (event) => {
        res.write(encoder.encode(event));
      },
      error: (err) => {
        res.write(
          encoder.encode({
            type: "RUN_ERROR",
            threadId: inputData.threadId ?? "unknown",
            runId: inputData.runId ?? "unknown",
            message: err instanceof Error ? err.message : String(err),
          } as any),
        );
        res.end();
      },
      complete: () => {
        res.end();
      },
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ error: "Not found", availableRoutes: Object.keys(adapters) }),
  );
}

function main(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "Error: OPENAI_API_KEY required (set OPENAI_BASE_URL to point at a LiteLLM proxy).",
    );
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? "8032", 10);
  const server = http.createServer(handleRequest);

  server.listen(port, "0.0.0.0", () => {
    const endpoint = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
    console.log(
      `OpenAI Agents JS server running on http://localhost:${port}`,
    );
    console.log(`  → inference endpoint: ${endpoint}`);
    for (const name of Object.keys(adapters)) {
      console.log(`  POST http://localhost:${port}/${name}`);
    }
    console.log(`  GET  http://localhost:${port}/health`);
  });
}

main();
