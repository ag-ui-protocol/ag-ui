import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEncoder } from "@ag-ui/encoder";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { OpenCodeBridge } from "./run-controller";

/** Authentication/authorization belongs to the host, never to body fields. */
export function createRequestHandler(options: {
  bridge: OpenCodeBridge;
  directory: string;
  authenticate: (request: IncomingMessage) => Promise<string | undefined>;
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/agentic_chat") {
      response.writeHead(404);
      response.end();
      return;
    }
    const fail = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: message }));
    };
    const owner = await options.authenticate(request).catch(() => undefined);
    if (!owner) {
      fail(401, "Authentication required");
      return;
    }
    if (request.headers["last-event-id"]) {
      fail(
        409,
        "Streaming resume is unsupported; do not replay a submitted turn",
      );
      return;
    }
    let input;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_048_576) {
          fail(413, "Request too large");
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      input = RunAgentInputSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
    } catch {
      fail(400, "Invalid RunAgentInput");
      return;
    }
    const encoder = new EventEncoder();
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const cancellation = new AbortController();
    const disconnect = () => {
      if (!response.writableEnded) cancellation.abort();
    };
    response.on("close", disconnect);
    try {
      await options.bridge.run(
        input,
        { owner, directory: options.directory, signal: cancellation.signal },
        (event) => {
          if (!response.destroyed) {
            response.write(encoder.encode(event));
            if (response.writableLength > 4_194_304)
              cancellation.abort(new Error("Slow client"));
          }
        },
      );
    } finally {
      response.off("close", disconnect);
      response.end();
    }
  };
}
