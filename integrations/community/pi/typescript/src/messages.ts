import type { Message, ToolCall } from "@ag-ui/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  TextContent,
  ImageContent,
} from "@earendil-works/pi-ai";

export interface HistoryEntry {
  id: string;
  message: AgentMessage;
}

export function publicText(
  parts: readonly (TextContent | ImageContent)[],
): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function committedCalls(message: AssistantMessage): ToolCall[] {
  if (message.stopReason === "error" || message.stopReason === "aborted")
    return [];
  return message.content
    .filter((part) => part.type === "toolCall")
    .map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
}

export function toAguiMessages(entries: readonly HistoryEntry[]): Message[] {
  const out: Message[] = [];
  for (const { id, message } of entries) {
    switch (message.role) {
      case "user": {
        const content =
          typeof message.content === "string"
            ? message.content
            : publicText(message.content);
        out.push({ id, role: "user", content });
        break;
      }
      case "assistant": {
        const content = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        const toolCalls = committedCalls(message);
        if (content || toolCalls.length) {
          out.push({
            id,
            role: "assistant",
            content,
            ...(toolCalls.length && { toolCalls }),
          });
        }
        break;
      }
      case "toolResult": {
        const content = publicText(message.content);
        out.push({
          id,
          role: "tool",
          content,
          toolCallId: message.toolCallId,
          ...(message.isError && { error: content || "Tool execution failed" }),
        });
        break;
      }
    }
  }
  return out;
}
