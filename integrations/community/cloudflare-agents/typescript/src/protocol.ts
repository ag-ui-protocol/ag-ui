import type { BaseEvent, RunAgentInput } from "@ag-ui/client";

/**
 * AG-UI over a Cloudflare Agents WebSocket (a custom AG-UI transport). The
 * frames share the socket with the Agents SDK's own protocol (state sync,
 * RPC), so every frame is a tagged JSON text message and each side ignores
 * frames it does not know.
 *
 * - A run starts with a `RunFrame`. Its events come back as `EventFrame`s,
 *   one event per frame, in order, tagged with the run id; several runs can
 *   share one socket.
 * - A run ends with the event frame carrying `RUN_FINISHED` or `RUN_ERROR`.
 * - An input the agent refuses comes back as a single `RUN_ERROR` event frame
 *   (code `INVALID_INPUT`, or `INVALID_RESUME`), without `RUN_STARTED`.
 * - An `AbortFrame` cancels a run started on the same connection; the run
 *   ends with `RUN_FINISHED` and the cancelled outcome. Closing the socket
 *   cancels its runs.
 */

/** Client -> agent: start a run. */
export interface RunFrame {
  type: "ag-ui:run";
  input: RunAgentInput;
}

/** Client -> agent: cancel a run. */
export interface AbortFrame {
  type: "ag-ui:abort";
  runId: string;
}

/** Agent -> client: one event of a run. */
export interface EventFrame {
  type: "ag-ui:event";
  /** The run the event belongs to; null when a refused run frame named none. */
  runId: string | null;
  event: BaseEvent;
}

export type ClientFrame = RunFrame | AbortFrame;

export const RUN_FRAME = "ag-ui:run";
export const ABORT_FRAME = "ag-ui:abort";
export const EVENT_FRAME = "ag-ui:event";

/** Parses a frame tagged `ag-ui:*`; anything else returns undefined. */
export function parseFrame(data: unknown): { type: string; [key: string]: unknown } | undefined {
  const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : undefined;
  if (!text || !text.includes('"ag-ui:')) return undefined;
  try {
    const frame: unknown = JSON.parse(text);
    if (
      typeof frame === "object" &&
      frame !== null &&
      typeof (frame as { type?: unknown }).type === "string" &&
      (frame as { type: string }).type.startsWith("ag-ui:")
    ) {
      return frame as { type: string; [key: string]: unknown };
    }
  } catch {
    // Not JSON: not ours.
  }
  return undefined;
}

/** The URL of one thread's agent: the agent's base URL plus the thread id. */
export function threadUrl(baseUrl: string, threadId: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(threadId)}`;
  return url.toString();
}
