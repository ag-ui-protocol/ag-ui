import { contentToText, type Message, type PartSource } from "@ag-ui/core";
import type {
  ModelMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
} from "ai";

// A media part's bytes as something the AI SDK can carry: a data URL or a
// plain URL. A `file` source is a handle only the issuing provider can
// resolve, and the spec forbids a consumer from fetching or parsing it, so
// there is nothing to hand the SDK — the caller drops the part.
function mediaSourceToUrl(source: PartSource): string | undefined {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  }
  if (source.type === "url") {
    return source.value;
  }
  return undefined;
}

function warnDroppedFileSource(partType: string): void {
  console.warn(
    `[convertMessagesToVercelAISDKMessages] Dropping ${partType} part: a provider-issued file handle cannot be forwarded to the AI SDK`,
  );
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

type UserPart = TextPart | ImagePart | FilePart;

// The user message content union from AG-UI (string | InputContent[]), derived
// from the Message union rather than re-declared here.
type UserContent = Extract<Message, { role: "user" }>["content"];

function toUserContent(content: UserContent): string | UserPart[] {
  if (!content) return "";
  if (typeof content === "string") return content;

  // A non-empty array converts to a parts array, even when every part is
  // text and even for a single part: joining text parts would alter the user's
  // input by introducing separators and losing part boundaries. Text is
  // user-provided and passes through verbatim, with no trimming and no
  // dropping of whitespace-only parts.
  const parts: UserPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image": {
        const url = mediaSourceToUrl(part.source);
        if (url === undefined) {
          warnDroppedFileSource("image");
          break;
        }
        parts.push({ type: "image", image: url });
        break;
      }
      case "audio":
      case "video":
      case "document": {
        const url = mediaSourceToUrl(part.source);
        if (url === undefined) {
          warnDroppedFileSource(part.type);
          break;
        }
        parts.push({
          type: "file",
          data: url,
          mediaType: part.source.mimeType ?? "application/octet-stream",
        });
        break;
      }
    }
  }
  // Providers reject an empty content array, so an empty turn is encoded as the
  // empty string; no user text is altered here because there is none.
  return parts.length ? parts : "";
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

// The assistant content parts union from the AI SDK (TextPart | FilePart |
// ReasoningPart | ToolCallPart | ...), without re-declaring the shapes here.
type AssistantParts = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;

export function convertMessagesToVercelAISDKMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  // AG-UI persists reasoning as standalone messages preceding their assistant
  // message. Buffer them and fold them into that assistant message as AI SDK
  // reasoning parts — for Anthropic extended thinking, the signed thinking
  // block (encryptedValue) must be replayed with the assistant turn or
  // tool-use continuations are rejected.
  let pendingReasoning: AssistantParts = [];

  for (const message of messages) {
    switch (message.role) {
      case "developer":
      case "system":
        pendingReasoning = [];
        result.push({ role: "system", content: message.content });
        break;
      case "user":
        pendingReasoning = [];
        result.push({ role: "user", content: toUserContent(message.content) });
        break;
      case "assistant": {
        const parts: AssistantParts = [...pendingReasoning];
        pendingReasoning = [];
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
        pendingReasoning = [];
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: lookupToolName(messages, message.toolCallId),
              // Preserve failure signaling: providers map error-text to their
              // native is_error flag, so the model can distinguish a failed
              // or denied call from a tool that returned this text.
              //
              // A tool result may carry content parts; the AI SDK's text and
              // error-text outputs take a plain string, so flatten with the
              // protocol's own downgrade (text parts joined, media dropped).
              output:
                message.error !== undefined
                  ? { type: "error-text", value: contentToText(message.content) }
                  : { type: "text", value: contentToText(message.content) },
            },
          ],
        });
        break;
      case "activity":
        pendingReasoning = [];
        break;
      case "reasoning":
        pendingReasoning.push({
          type: "reasoning",
          text: message.content ?? "",
          ...(message.encryptedValue
            ? { providerOptions: { anthropic: { signature: message.encryptedValue } } }
            : {}),
        });
        break;
    }
  }

  return result;
}
