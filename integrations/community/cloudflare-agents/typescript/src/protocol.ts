import type { BaseEvent, RunAgentInput } from "@ag-ui/client";

/**
 * AG-UI over a Cloudflare Agents WebSocket. The frames share the socket with
 * the Agents SDK's own protocol (state sync, RPC), so every frame is tagged
 * and each side ignores frames it does not know.
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
  runId: string;
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
