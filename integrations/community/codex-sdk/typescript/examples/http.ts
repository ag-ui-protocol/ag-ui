import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";
import { Subscription } from "rxjs";
import { CodexAgentAdapter } from "../src/index";

export interface ServerOptions {
  agent: CodexAgentAdapter;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  maxBufferedBytes?: number;
  stalledClientTimeoutMs?: number;
}

function json(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

function isAllowedOrigin(origin: string, allowlist: string[]) {
  if (allowlist.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

async function body(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function stream(
  response: ServerResponse,
  agent: CodexAgentAdapter,
  input: ReturnType<typeof RunAgentInputSchema.parse>,
  options: ServerOptions,
) {
  const encoder = new EventEncoder();
  response.writeHead(200, {
    "Content-Type": encoder.getContentType(),
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let completed = false;
  let detached = false;
  const subscription = new Subscription();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    detached = true;
    if (timer) clearTimeout(timer);
    subscription?.unsubscribe();
    queue.length = 0;
  };
  const disconnect = () => {
    cleanup();
    response.destroy();
  };
  const flush = () => {
    if (detached || blocked) return;
    while (queue.length) {
      const chunk = queue.shift();
      if (chunk === undefined) break;
      queuedBytes -= Buffer.byteLength(chunk);
      if (!response.write(chunk)) {
        blocked = true;
        timer = setTimeout(disconnect, options.stalledClientTimeoutMs ?? 5000);
        return;
      }
    }
    if (completed) response.end();
  };
  response.on("close", cleanup);
  response.on("error", disconnect);
  response.on("drain", () => {
    blocked = false;
    if (timer) clearTimeout(timer);
    flush();
  });
  subscription.add(
    agent.run(input).subscribe({
      next(event: BaseEvent) {
        if (detached) return;
        const chunk = encoder.encode(event);
        queuedBytes += Buffer.byteLength(chunk);
        if (
          queuedBytes + response.writableLength >
          (options.maxBufferedBytes ?? 1024 * 1024)
        ) {
          disconnect();
          return;
        }
        queue.push(chunk);
        flush();
      },
      error() {
        disconnect();
      },
      complete() {
        completed = true;
        flush();
      },
    }),
  );
  if (detached) subscription.unsubscribe();
}

export function createCodexServer(options: ServerOptions) {
  for (const value of [
    options.maxBodyBytes,
    options.maxBufferedBytes,
    options.stalledClientTimeoutMs,
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new Error("Server limits must be positive integers.");
  }
  return createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      response.setHeader("Vary", "Origin");
      if (origin && !isAllowedOrigin(origin, options.allowedOrigins ?? []))
        return json(response, 403, "Origin is not allowed.");
      if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept",
        });
        response.end();
        return;
      }
      if (request.url === "/health" && request.method === "GET")
        return json(response, 200, "ok");
      if (request.url !== "/agentic_chat")
        return json(response, 404, "Not found.");
      if (request.method !== "POST") return json(response, 405, "Use POST.");
      const maxBytes = options.maxBodyBytes ?? 1024 * 1024;
      const length = request.headers["content-length"];
      if (length && Number(length) > maxBytes)
        return json(response, 413, "Request body is too large.");
      let raw: unknown;
      try {
        raw = await body(request, maxBytes);
      } catch (error) {
        return json(
          response,
          error instanceof Error && error.message === "BODY_TOO_LARGE"
            ? 413
            : 400,
          "Invalid request body.",
        );
      }
      const parsed = RunAgentInputSchema.safeParse(raw);
      if (!parsed.success) return json(response, 400, "Invalid RunAgentInput.");
      stream(response, options.agent.clone(), parsed.data, options);
    } catch {
      if (response.headersSent) response.destroy();
      else json(response, 500, "Server request failed.");
    }
  });
}
