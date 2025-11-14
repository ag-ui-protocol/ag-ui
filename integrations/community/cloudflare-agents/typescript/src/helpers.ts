/**
 * Helper functions for creating AG-UI compatible HTTP responses
 *
 * These helpers make it easy to stream AG-UI events over SSE or NDJSON
 * from Cloudflare Workers.
 */

import { type BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";

/**
 * Create an SSE response for streaming AG-UI events
 *
 * @param events$ - Observable stream of AG-UI events
 * @param additionalHeaders - Optional additional headers (e.g., CORS)
 * @returns Response with Server-Sent Events stream
 */
export function createSSEResponse(
  events$: Observable<BaseEvent>,
  additionalHeaders?: Record<string, string>
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  events$.subscribe({
    next: (event) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      writer.write(encoder.encode(data)).catch(console.error);
    },
    error: (error) => {
      console.error("Stream error:", error);
      writer.close().catch(console.error);
    },
    complete: () => {
      writer.close().catch(console.error);
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...additionalHeaders,
    },
  });
}

/**
 * Create an NDJSON response for streaming AG-UI events
 *
 * @param events$ - Observable stream of AG-UI events
 * @param additionalHeaders - Optional additional headers (e.g., CORS)
 * @returns Response with newline-delimited JSON stream
 */
export function createNDJSONResponse(
  events$: Observable<BaseEvent>,
  additionalHeaders?: Record<string, string>
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  events$.subscribe({
    next: (event) => {
      const data = `${JSON.stringify(event)}\n`;
      writer.write(encoder.encode(data)).catch(console.error);
    },
    error: (error) => {
      console.error("Stream error:", error);
      writer.close().catch(console.error);
    },
    complete: () => {
      writer.close().catch(console.error);
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...additionalHeaders,
    },
  });
}
