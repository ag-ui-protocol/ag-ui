/**
 * Helpers for streaming AG-UI events over SSE or NDJSON
 */

import { type BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";

/**
 * Create SSE response for streaming AG-UI events
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
 * Create NDJSON response for streaming AG-UI events
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
