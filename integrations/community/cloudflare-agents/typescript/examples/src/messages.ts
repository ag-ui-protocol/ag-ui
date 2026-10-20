import type { Message } from "@ag-ui/client";
import type { ModelMessage } from "ai";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function parseArgs(args: string): unknown {
  try {
    return args ? JSON.parse(args) : {};
  } catch {
    return {};
  }
}

/**
 * Convert AG-UI messages into AI SDK v5 model messages. System and developer
 * messages are dropped here because the agent passes its own system prompt;
 * activity and reasoning messages carry nothing the model needs to see.
 */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const result: ModelMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "user":
        result.push({ role: "user", content: textOf(message.content) });
        break;

      case "assistant": {
        const parts: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: unknown;
            }
        > = [];
        const text = textOf(message.content);
        if (text) parts.push({ type: "text", text });
        for (const call of message.toolCalls ?? []) {
          toolNames.set(call.id, call.function.name);
          parts.push({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseArgs(call.function.arguments),
          });
        }
        if (parts.length > 0)
          result.push({ role: "assistant", content: parts });
        break;
      }

      case "tool":
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: toolNames.get(message.toolCallId) ?? "unknown",
              output: { type: "text", value: textOf(message.content) },
            },
          ],
        });
        break;

      default:
        break;
    }
  }

  return result;
}
