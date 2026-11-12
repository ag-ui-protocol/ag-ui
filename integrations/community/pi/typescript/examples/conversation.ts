import type { Message, RunAgentInput } from "@ag-ui/core";
import type { Api, JsonObject, Model, ToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function text(message: Extract<Message, { role: "user" | "tool" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type !== "text") throw new Error("Expected text content");
      return part.text;
    })
    .join("\n");
}

function argumentsObject(serialized: string): JsonObject {
  const value = JSON.parse(serialized);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected tool arguments");
  return value;
}

export function endsWithRenderedCards(messages: RunAgentInput["messages"]): boolean {
  if (messages.at(-1)?.role !== "tool") return false;
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const proposal = messages[index];
  if (proposal?.role !== "assistant" || !proposal.toolCalls?.length) return false;
  if (!proposal.toolCalls.every((call) => call.function.name === "render_card")) return false;

  return messages.slice(index + 1).every((result) => {
    if (result.role !== "tool" || result.error != null) return false;
    try {
      return JSON.parse(text(result))?.rendered === true;
    } catch {
      return false;
    }
  });
}

export function conversation(input: RunAgentInput, model: Model<Api>) {
  const latest = input.messages.at(-1);
  if ((latest?.role !== "user" && latest?.role !== "tool") || input.resume?.length) {
    throw new Error("Expected a user prompt or a tool result");
  }
  const prompt = latest.role === "user" ? text(latest) : undefined;
  if (prompt !== undefined && !prompt.trim()) throw new Error("Expected a nonempty prompt");

  const sessionManager = SessionManager.inMemory();
  const pending = new Map<string, string>();
  const history = latest.role === "user" ? input.messages.slice(0, -1) : input.messages;
  for (const message of history) {
    if (message.role === "tool") {
      const name = pending.get(message.toolCallId);
      if (!name) throw new Error("Unexpected or duplicate tool result");
      pending.delete(message.toolCallId);
      sessionManager.appendMessage({
        role: "toolResult",
        timestamp: Date.now(),
        toolCallId: message.toolCallId,
        toolName: name,
        content: [{ type: "text", text: text(message) }],
        isError: Boolean(message.error),
      });
      continue;
    }
    if (pending.size) throw new Error("Expected the remaining tool results");
    if (message.role === "user") {
      sessionManager.appendMessage({ role: "user", timestamp: Date.now(), content: text(message) });
    } else if (message.role === "assistant") {
      const calls = (message.toolCalls ?? []).map((call): ToolCall => {
        if (pending.has(call.id)) throw new Error("Duplicate tool call");
        pending.set(call.id, call.function.name);
        return {
          type: "toolCall",
          id: call.id,
          name: call.function.name,
          arguments: argumentsObject(call.function.arguments),
        };
      });
      sessionManager.appendMessage({
        role: "assistant",
        timestamp: Date.now(),
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...calls,
        ],
        stopReason: calls.length ? "toolUse" : "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    } else if (message.role !== "system" && message.role !== "developer") {
      throw new Error("Unsupported message role");
    }
  }
  if (pending.size) throw new Error("Expected one result for each tool call");
  return { prompt, sessionManager };
}
