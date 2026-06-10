import { EventType, type BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";

export function createSSEResponse(
  events$: Observable<BaseEvent>,
  additionalHeaders?: Record<string, string>,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  events$.subscribe({
    next: (event) => {
      writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});
    },
    error: (error) => {
      const errorEvent: BaseEvent = {
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
        code: "STREAM_ERROR",
        timestamp: Date.now(),
      };
      writer.write(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`))
        .then(() => writer.close())
        .catch(() => writer.close().catch(() => {}));
    },
    complete: () => { writer.close().catch(() => {}); },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...additionalHeaders },
  });
}

export function createNDJSONResponse(
  events$: Observable<BaseEvent>,
  additionalHeaders?: Record<string, string>,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  events$.subscribe({
    next: (event) => {
      writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
    },
    error: (error) => {
      const errorEvent: BaseEvent = {
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
        code: "STREAM_ERROR",
        timestamp: Date.now(),
      };
      writer.write(encoder.encode(`${JSON.stringify(errorEvent)}\n`))
        .then(() => writer.close())
        .catch(() => writer.close().catch(() => {}));
    },
    complete: () => { writer.close().catch(() => {}); },
  });

  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", Connection: "keep-alive", ...additionalHeaders },
  });
}
