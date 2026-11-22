import type { Message, ToolCall, ToolMessage } from "@ag-ui/client";

/**
 * Client-tool trace context propagation across the two-run boundary
 * (`@mastra/core` `CLIENT_TOOL_CALL` -> AG-UI `TOOL_CALL_START` ->
 * `ToolMessage` -> `tool-result.__mastraObservability`).
 */

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

export interface MastraToolResultObservability {
  parentContext: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePlainRecord(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  try {
    const cloned = structuredClone(value);
    return isRecord(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}

export function isValidTraceparent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TRACEPARENT_RE.exec(value);
  if (!match) return false;
  const [, version, traceId, spanId] = match;
  return version !== "ff" && traceId !== ZERO_TRACE_ID && spanId !== ZERO_SPAN_ID;
}

/**
 * Reads and validates a W3C trace context carrier (`{ traceparent, ... }`)
 * from a Mastra tool-call chunk or AG-UI `ToolCall.metadata.mastra.observability`.
 */
export function readObservabilityCarrier(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isValidTraceparent(value.traceparent)) {
    return undefined;
  }
  return clonePlainRecord(value);
}

/**
 * Formats a validated carrier into AG-UI `metadata` for `TOOL_CALL_START` /
 * `TOOL_CALL_END`.
 */
export function observabilityMetadata(
  carrier: Record<string, unknown>,
): Record<string, unknown> {
  return { mastra: { observability: carrier } };
}

/**
 * Reads the W3C carrier stored on an AG-UI assistant `ToolCall`'s metadata.
 */
export function readToolCallObservabilityCarrier(
  toolCall: ToolCall | undefined,
): Record<string, unknown> | undefined {
  if (!toolCall || !isRecord(toolCall.metadata)) return undefined;
  const mastraMeta = toolCall.metadata.mastra;
  if (!isRecord(mastraMeta)) return undefined;
  return readObservabilityCarrier(mastraMeta.observability);
}

/**
 * Extracts and validates `__mastraObservability` for a Mastra `tool-result`
 * block from the matched `ToolCall` carrier and the `ToolMessage` payload.
 *
 * Returns `undefined` when:
 * - the matched `ToolCall` carried no valid trace context carrier,
 * - the `ToolMessage` has no client-supplied `payload`, or
 * - the `ToolMessage` includes a conflicting `parentContext` / `traceparent`.
 */
export function readToolResultObservability(
  toolCall: ToolCall | undefined,
  toolMessage: ToolMessage,
): MastraToolResultObservability | undefined {
  const carrier = readToolCallObservabilityCarrier(toolCall);
  if (!carrier) return undefined;

  if (!isRecord(toolMessage.metadata)) return undefined;
  const mastraMeta = toolMessage.metadata.mastra;
  if (!isRecord(mastraMeta)) return undefined;
  const obs = mastraMeta.observability;
  if (!isRecord(obs)) return undefined;

  // Never trust a client-supplied parentContext that disagrees with the
  // assistant tool call's trace context.
  if (obs.parentContext !== undefined) {
    const supplied = readObservabilityCarrier(obs.parentContext);
    if (!supplied || supplied.traceparent !== carrier.traceparent) {
      console.warn(
        `[convertAGUIMessagesToMastra] Dropping client observability for toolCallId ${toolMessage.toolCallId}: parentContext does not match tool call carrier`,
      );
      return undefined;
    }
  }
  if (obs.traceparent !== undefined && obs.traceparent !== carrier.traceparent) {
    console.warn(
      `[convertAGUIMessagesToMastra] Dropping client observability for toolCallId ${toolMessage.toolCallId}: traceparent does not match tool call carrier`,
    );
    return undefined;
  }

  if (!isRecord(obs.payload) || Object.keys(obs.payload).length === 0) {
    return undefined;
  }
  const payload = clonePlainRecord(obs.payload);
  if (!payload) return undefined;

  return {
    parentContext: carrier,
    payload,
  };
}

/**
 * Returns true when `toolMessage` appears in `lookupMessages` before a later
 * `assistant` message, meaning Mastra has already processed that turn and the
 * tool result is being replayed as conversation history.
 */
export function isReplayedToolResultMessage(
  lookupMessages: Message[],
  lookupIndex: number,
): boolean {
  if (lookupIndex === -1) return false;
  for (let i = lookupIndex + 1; i < lookupMessages.length; i++) {
    if (lookupMessages[i]?.role === "assistant") {
      return true;
    }
  }
  return false;
}

/**
 * Collects tool call IDs whose results are already persisted in Mastra memory,
 * so re-sent tool messages from prior turns do not re-emit client spans.
 */
export function collectAnsweredToolCallIds(stored: unknown[]): Set<string> {
  const answered = new Set<string>();
  for (const msg of stored) {
    if (!isRecord(msg)) continue;
    const content = msg.content;
    if (!isRecord(content) || !Array.isArray(content.parts)) continue;
    for (const part of content.parts) {
      if (!isRecord(part)) continue;
      if (part.type === "tool-invocation" && isRecord(part.toolInvocation)) {
        const { toolCallId, state } = part.toolInvocation;
        if (
          typeof toolCallId === "string" &&
          (state === "result" ||
            state === "output-available" ||
            state === "output-error")
        ) {
          answered.add(toolCallId);
        }
      } else if (
        part.type === "tool-result" &&
        typeof part.toolCallId === "string"
      ) {
        answered.add(part.toolCallId);
      }
    }
  }
  return answered;
}
