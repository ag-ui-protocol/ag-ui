import type {
  Message,
  InputContent,
  InputContentDataSource,
  InputContentUrlSource,
} from "@ag-ui/core";
import type {
  ModelMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
} from "ai";

function mediaSourceToUrl(source: InputContentDataSource | InputContentUrlSource): string {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  }
  return source.value;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

type UserPart = TextPart | ImagePart | FilePart;

function toUserContent(content: Message["content"]): string | UserPart[] {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const hasNonText = content.some((part) => part.type !== "text");

  if (!hasNonText) {
    type TextInput = Extract<InputContent, { type: "text" }>;
    return content
      .filter((part): part is TextInput => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
  }

  const parts: UserPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image":
        parts.push({ type: "image", image: mediaSourceToUrl(part.source) });
        break;
      case "audio":
      case "video":
      case "document":
        parts.push({
          type: "file",
          data: mediaSourceToUrl(part.source),
          mediaType: part.source.mimeType ?? "application/octet-stream",
        });
        break;
      case "binary": {
        if (part.url) {
          parts.push({ type: "image", image: part.url });
        } else if (part.data && part.mimeType) {
          parts.push({
            type: "image",
            image: `data:${part.mimeType};base64,${part.data}`,
          });
        } else {
          console.warn(
            "[convertMessagesToVercelAISDKMessages] Dropping BinaryInputContent: no url or data provided",
          );
        }
        break;
      }
    }
  }
  return parts;
}

function lookupToolName(messages: Message[], toolCallId: string): string {
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const tc of msg.toolCalls ?? []) {
        if (tc.id === toolCallId) {
          return tc.function.name;
        }
      }
    }
  }
  return "unknown";
}

export function convertMessagesToVercelAISDKMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "developer":
      case "system":
        result.push({ role: "system", content: message.content });
        break;
      case "user":
        result.push({ role: "user", content: toUserContent(message.content) });
        break;
      case "assistant": {
        const parts: Array<TextPart | ToolCallPart> = [];
        if (message.content) {
          parts.push({ type: "text", text: message.content });
        }
        for (const tc of message.toolCalls ?? []) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: safeJsonParse(tc.function.arguments),
          });
        }
        result.push({
          role: "assistant",
          content: parts.length ? parts : "",
        });
        break;
      }
      case "tool":
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: lookupToolName(messages, message.toolCallId),
              output: { type: "text", value: message.content },
            },
          ],
        });
        break;
      case "activity":
      case "reasoning":
        break;
    }
  }

  return result;
}
