import { Message } from "@ag-ui/client";
import { contentHasMedia, contentToText } from "@ag-ui/core";
import type { ContentPart, ImagePart } from "@ag-ui/core";
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

/**
 * A LangChain content block this bridge produces for a user message: text, or
 * an image in the OpenAI-style `image_url` shape that LangChain's chat model
 * integrations understand (and that both @langchain/core 0.3 and 1.x accept
 * as message content).
 */
type LangChainUserContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Warns about AG-UI content this bridge cannot hand to LangChain. Honours
 * `SUPPRESS_TRANSFORMATION_WARNINGS`, the switch the rest of AG-UI's
 * transformation warnings sit behind.
 */
function warnDropped(message: string): void {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS)
  ) {
    return;
  }
  console.warn(message);
}

/**
 * The URL a LangChain `image_url` block can carry for an AG-UI image part:
 * the URL itself, or a data URL for inline bytes. A provider file handle has
 * no portable LangChain shape, so it yields undefined and is dropped.
 */
function imagePartUrl(part: ImagePart): string | undefined {
  switch (part.source.type) {
    case "url":
      return part.source.value;
    case "data":
      return `data:${part.source.mimeType};base64,${part.source.value}`;
    default:
      return undefined;
  }
}

/**
 * Maps user-message content parts to LangChain content. Text parts become
 * text blocks and URL/inline image parts become `image_url` blocks; anything
 * else (audio, video, documents, provider file handles) has no portable
 * LangChain shape and is dropped with a warning. Text-only content stays a
 * plain string, the shape every model accepts.
 */
function convertUserContent(
  messageId: string,
  parts: ContentPart[],
): string | LangChainUserContentBlock[] {
  const blocks: LangChainUserContentBlock[] = [];
  const dropped: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const url = imagePartUrl(part);
      if (url !== undefined) {
        blocks.push({ type: "image_url", image_url: { url } });
      } else {
        dropped.push(`image (${part.source.type} source)`);
      }
    } else {
      dropped.push(part.type);
    }
  }

  if (dropped.length > 0) {
    warnDropped(
      `[ag-ui][langchain] User message '${messageId}' carries content parts this bridge cannot pass to LangChain; dropping: ${dropped.join(", ")}.`,
    );
  }

  if (blocks.every((block) => block.type === "text")) {
    return contentToText(parts);
  }
  return blocks;
}

/**
 * The content of a LangChain ToolMessage for an AG-UI tool result. AG-UI
 * content parts are not LangChain content blocks, and provider support for
 * media in tool results varies, so the result is flattened to its text; any
 * media it carried is dropped with a warning.
 */
function convertToolContent(
  toolCallId: string,
  content: string | ContentPart[],
): string {
  if (contentHasMedia(content)) {
    warnDropped(
      `[ag-ui][langchain] The result of tool call '${toolCallId}' carries media content parts; only its text parts are passed to LangChain and the rest is dropped.`,
    );
  }
  return contentToText(content);
}

/**
 * Converts AG-UI Message to LangChain BaseMessage
 */
export function convertAGUIMessageToLangChain(message: Message): BaseMessage {
  // User message
  if (message.role === "user") {
    // Handle string content
    if (typeof message.content === "string") {
      return new HumanMessage(message.content);
    }
    // Handle array content: text and image parts map to LangChain blocks
    if (Array.isArray(message.content)) {
      return new HumanMessage({
        content: convertUserContent(message.id, message.content),
      });
    }
    return new HumanMessage("");
  }

  // Assistant message
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments),
    })) || [];

    return new AIMessage({
      content: message.content || "",
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }

  // Tool/Function result message
  if (message.role === "tool") {
    return new ToolMessage({
      content: convertToolContent(message.toolCallId, message.content),
      tool_call_id: message.toolCallId,
      // Carry the AG-UI failure signal onto LangChain's tool-result status, so a
      // client-reported tool failure is not delivered to the model as a success.
      status: message.error ? "error" : "success",
    });
  }

  // System message
  if (message.role === "system") {
    return new SystemMessage(message.content as string);
  }

  // Fallback - treat as human message
  return new HumanMessage(String(message.content || ""));
}

/**
 * Converts array of AG-UI Messages to LangChain BaseMessages
 */
export function convertAGUIMessagesToLangChain(messages: Message[]): BaseMessage[] {
  return messages.map(convertAGUIMessageToLangChain);
}
