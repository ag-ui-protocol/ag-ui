/**
 * Utilities for the OpenAI Agents JS adapter.
 */

import { randomUUID } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";

/**
 * Generate a stable-ish message ID, preferring the caller-supplied base.
 */
export function genMessageId(base?: string): string {
  return base ?? randomUUID();
}

/**
 * Normalize an AG-UI message's content to a plain string for the SDK input.
 *
 * The SDK accepts string content or an array of typed input parts. For Phase 2
 * we pass through string content; non-string user content is JSON-encoded so
 * nothing is silently dropped. Rich input parts are a future enhancement.
 */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Convert AG-UI input messages into OpenAI Agents JS `AgentInputItem[]`.
 *
 * Only user / system / developer / assistant / tool roles are mapped to SDK
 * input items; reasoning and activity messages are ag-ui-specific and have no
 * SDK input equivalent, so they are dropped from the forwarded input (they may
 * still appear in MESSAGES_SNAPSHOT).
 */
export function messagesToSdkInput(messages: Message[]): unknown[] {
  const items: unknown[] = [];
  const toolCalls = new Map(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((toolCall) => [toolCall.id, toolCall] as const)
        : [],
    ),
  );
  const emittedCallIds = new Set<string>();
  const emitCall = (toolCallId: string) => {
    const toolCall = toolCalls.get(toolCallId);
    if (!toolCall || emittedCallIds.has(toolCallId)) return;
    emittedCallIds.add(toolCallId);
    items.push({
      type: "function_call",
      callId: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: "completed",
    });
  };
  for (const m of messages) {
    switch (m.role) {
      case "user":
        items.push({
          role: "user",
          content: contentToString(m.content),
        });
        break;
      case "system":
        items.push({
          role: "system",
          content: contentToString(m.content),
        });
        break;
      case "developer":
        // The OpenAI Responses API has no "developer" role; map to system.
        items.push({
          role: "system",
          content: contentToString(m.content),
        });
        break;
      case "assistant":
        if (m.content != null) {
          items.push({
            role: "assistant",
            content: contentToString(m.content),
          });
        }
        for (const toolCall of m.toolCalls ?? []) {
          emitCall(toolCall.id);
        }
        break;
      case "tool": {
        emitCall(m.toolCallId);
        items.push({
          type: "function_call_result",
          callId: m.toolCallId,
          name: toolCalls.get(m.toolCallId)?.function.name ?? m.toolCallId,
          output: contentToString(m.content),
          status: m.error ? "incomplete" : "completed",
        });
        break;
      }
      default:
        // reasoning / activity — no SDK input equivalent; skip.
        break;
    }
  }
  return items;
}

/**
 * Best-effort coercion of a tool output value to a string for TOOL_CALL_RESULT.
 */
export function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  if (typeof output === "object") {
    // SDK RunToolCallOutputItem.output may be a structured object; the AG-UI
    // TOOL_CALL_RESULT content is a string, so JSON-encode structured output.
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output);
}
