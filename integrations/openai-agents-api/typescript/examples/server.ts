/**
 * Dojo example server: one AG-UI endpoint per feature, each backed by OpenAI
 * Agents API sessions. Nothing to provision: sessions are created on demand.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... pnpm dev:examples
 */

import http from "node:http";
import { EventEncoder } from "@ag-ui/encoder";
import type { AbstractAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { buildAgents, MODEL } from "./agents";
import { isEntry } from "./entry";

const agents = buildAgents();

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

  const route = new URL(
    req.url ?? "/",
    `http://${req.headers.host}`,
  ).pathname.replace(/^\/|\/$/g, "");

  if (req.method === "GET" && route === "health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        model: MODEL,
        agents: Object.keys(agents),
      }),
    );
    return;
  }

  const agent = Object.hasOwn(agents, route) ? agents[route] : undefined;
  if (req.method !== "POST" || !agent) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not found",
        availableRoutes: Object.keys(agents),
      }),
    );
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  // Parsed, not cast: a client may omit `tools` / `context`, and the schema
  // fills in the defaults the adapter relies on.
  const parsed = RunAgentInputSchema.safeParse(body);
  if (!parsed.success) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Invalid RunAgentInput",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      }),
    );
    return;
  }
  const input: RunAgentInput = parsed.data;

  const encoder = new EventEncoder({
    accept: req.headers.accept ?? "text/event-stream",
  });
  res.writeHead(200, {
    "Content-Type": encoder.getContentType(),
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  await streamRun(agent.clone(), input, encoder, res);
}

/** Streams one run into an already-open SSE response. */
export function streamRun(
  agent: Pick<AbstractAgent, "run">,
  input: RunAgentInput,
  encoder: EventEncoder,
  res: http.ServerResponse,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const subscription = agent.run(input).subscribe({
      next: (event) => {
        // LOG_EVENTS=1 prints every event type the client receives.
        if (process.env.LOG_EVENTS)
          console.log(`[${input.threadId}] ${event.type}`);
        res.write(encoder.encode(event));
      },
      // A failed stream must not look finished: break the connection instead of
      // ending it cleanly, so the client cannot mistake it for a complete run.
      error: (err: unknown) => {
        console.error("Run failed mid-stream:", err);
        res.destroy(err instanceof Error ? err : new Error(String(err)));
        resolve();
      },
      complete: () => {
        res.end();
        resolve();
      },
    });
    // The client went away: unsubscribing cancels the session's turn.
    res.on("close", () => {
      subscription.unsubscribe();
      resolve();
    });
  });
}

export const safeHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  handleRequest(req, res).catch((err: unknown) => {
    const aborted =
      req.destroyed ||
      res.destroyed ||
      (err as { code?: string } | undefined)?.code === "ECONNRESET";
    if (!aborted) console.error("Request failed:", err);
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!res.writableEnded) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
};

function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: set OPENAI_API_KEY");
    process.exit(1);
  }
  const port = parseInt(process.env.PORT ?? "8027", 10);
  http.createServer(safeHandler).listen(port, "0.0.0.0", () => {
    console.log(
      `OpenAI Agents API server running on http://localhost:${port} (model ${MODEL})`,
    );
    for (const name of Object.keys(agents))
      console.log(`  POST http://localhost:${port}/${name}`);
    console.log(`  GET  http://localhost:${port}/health`);
  });
}

if (isEntry(import.meta.url)) {
  main();
}
