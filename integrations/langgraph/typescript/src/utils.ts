import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { State, SchemaKeys, LangGraphReasoning } from "./types";
import {
  Message,
  ToolCall,
  TextInputContent,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
  InputContentDataSource,
  InputContentUrlSource,
  InputContent,
  UserMessage,
} from "@ag-ui/client";

export const DEFAULT_SCHEMA_KEYS = ["messages", "tools"];

export function filterObjectBySchemaKeys(obj: Record<string, any>, schemaKeys: string[]) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => schemaKeys.includes(key)));
}

export function getStreamPayloadInput({
  mode,
  state,
  schemaKeys,
}: {
  mode: "start" | "continue";
  state: State;
  schemaKeys: SchemaKeys;
}) {
  let input = mode === "start" ? state : null;
  // Do not input keys that are not part of the input schema
  if (input && schemaKeys?.input) {
    input = filterObjectBySchemaKeys(input, [...DEFAULT_SCHEMA_KEYS, ...schemaKeys.input]);
  }

  return input;
}

const MEDIA_CONTENT_TYPES = new Set(["image", "audio", "video", "document"]);

function mediaSourceToUrl(source: InputContentDataSource | InputContentUrlSource): string | null {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  } else if (source.type === "url") {
    return source.value;
  }
  return null;
}

/**
 * Convert LangChain's multimodal content to AG-UI format.
 *
 * LangChain only supports `text` and `image_url` content blocks.
 * `image_url` blocks are converted to `ImageInputContent` with the
 * appropriate source type (data or URL).
 */
function convertLangchainMultimodalToAgui(
  content: Array<{ type: string; text?: string; image_url?: any }>
): InputContent[] {
  const aguiContent: InputContent[] = [];

  for (const item of content) {
    if (item.type === "text" && item.text) {
      aguiContent.push({
        type: "text",
        text: item.text,
      });
    } else if (item.type === "image_url") {
      // LangChain only uses `image_url` blocks for all media, so we always
      // produce ImageInputContent here. The true media type is not recoverable.
      const imageUrl = typeof item.image_url === "string"
        ? item.image_url
        : item.image_url?.url;

      if (!imageUrl) continue;

      // Parse data URLs to extract base64 data
      if (imageUrl.startsWith("data:")) {
        // Format: data:mime_type;base64,data
        const [header, data] = imageUrl.split(",", 2);
        const mimeType = header.includes(":")
          ? header.split(":")[1].split(";")[0]
          : "image/png";

        aguiContent.push({
          type: "image",
          source: {
            type: "data",
            value: data || "",
            mimeType,
          },
        });
      } else {
        // Regular URL
        aguiContent.push({
          type: "image",
          source: {
            type: "url",
            value: imageUrl,
          },
        });
      }
    }
  }

  return aguiContent;
}

/**
 * Convert AG-UI multimodal content to LangChain's format.
 *
 * Handles the new typed content classes (ImageInputContent, AudioInputContent,
 * VideoInputContent, DocumentInputContent) as well as legacy BinaryInputContent
 * for backwards compatibility. All media types are routed through LangChain's
 * `image_url` format since that is the only media block type LangChain supports.
 */
function convertAguiMultimodalToLangchain(
  content: InputContent[]
): Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const langchainContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  for (const item of content) {
    if (item.type === "text") {
      langchainContent.push({
        type: "text",
        text: item.text,
      });
    } else if (MEDIA_CONTENT_TYPES.has(item.type)) {
      // ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent
      const mediaItem = item as ImageInputContent | AudioInputContent | VideoInputContent | DocumentInputContent;
      const url = mediaSourceToUrl(mediaItem.source);
      if (url) {
        langchainContent.push({
          type: "image_url",
          image_url: { url },
        });
      } else {
        console.warn(`[convertAguiMultimodalToLangchain] Dropping ${item.type} content: source could not be converted to URL`);
      }
    } else if (item.type === "binary") {
      // Legacy BinaryInputContent — backwards compatibility
      let url: string;

      // Prioritize url, then data, then id
      if (item.url) {
        url = item.url;
      } else if (item.data) {
        // Construct data URL from base64 data
        url = `data:${item.mimeType};base64,${item.data}`;
      } else if (item.id) {
        // Use id as a reference
        url = item.id;
      } else {
        console.warn("[convertAguiMultimodalToLangchain] Dropping BinaryInputContent: no url, data, or id provided");
        continue;
      }

      langchainContent.push({
        type: "image_url",
        image_url: { url },
      });
    }
  }

  return langchainContent;
}

export function langchainMessagesToAgui(messages: LangGraphMessage[]): Message[] {
  return messages.map((message) => {
    switch (message.type) {
      case "human":
        // Handle multimodal content
        let userContent: string | InputContent[];
        if (Array.isArray(message.content)) {
          userContent = convertLangchainMultimodalToAgui(message.content as any);
        } else {
          userContent = stringifyIfNeeded(resolveMessageContent(message.content));
        }

        return {
          id: message.id!,
          role: "user",
          content: userContent,
        };
      case "ai":
        const aiContent = resolveMessageContent(message.content)
        return {
          id: message.id!,
          role: "assistant",
          content: aiContent ? stringifyIfNeeded(aiContent) : '',
          toolCalls: message.tool_calls?.map((tc) => ({
            id: tc.id!,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        };
      case "system":
        return {
          id: message.id!,
          role: "system",
          content: stringifyIfNeeded(resolveMessageContent(message.content)),
        };
      case "tool":
        return {
          id: message.id!,
          role: "tool",
          content: stringifyIfNeeded(resolveMessageContent(message.content)),
          toolCallId: message.tool_call_id,
        };
      default:
        throw new Error("message type returned from LangGraph is not supported.");
    }
  });
}

export function aguiMessagesToLangChain(messages: Message[]): LangGraphMessage[] {
  return messages.map((message, index) => {
    switch (message.role) {
      case "user":
        // Handle multimodal content
        let content: UserMessage['content'];
        if (typeof message.content === "string") {
          content = message.content;
        } else if (Array.isArray(message.content)) {
          content = convertAguiMultimodalToLangchain(message.content) as any;
        } else {
          content = String(message.content);
        }

        return {
          id: message.id,
          role: message.role,
          content,
          type: "human",
        } as LangGraphMessage;
      case "assistant":
        return {
          id: message.id,
          type: "ai",
          role: message.role,
          content: message.content ?? "",
          tool_calls: (message.toolCalls ?? []).map((tc: ToolCall) => ({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
            type: "tool_call",
          })),
        };
      case "system":
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          type: "system",
        };
      case "tool":
        return {
          content: message.content,
          role: message.role,
          type: message.role,
          tool_call_id: message.toolCallId,
          id: message.id,
        };
      default:
        console.error(`Message role ${message.role} is not implemented`);
        throw new Error("message role is not supported.");
    }
  });
}

function stringifyIfNeeded(item: any) {
  if (typeof item === "string") return item;
  return JSON.stringify(item);
}

export function resolveReasoningContent(eventData: any): LangGraphReasoning | null {
  const content = eventData.chunk?.content

  if (content && Array.isArray(content) && content.length && content[0]) {
    const block = content[0];

    // Old langchain-anthropic format: { type: "thinking", thinking: "..." }
    if (block.type === 'thinking' && block.thinking) {
      const result: LangGraphReasoning = {
        text: block.thinking,
        type: 'text',
        index: block.index ?? 0,
      }
      // Extract signature if present (Anthropic extended thinking signature)
      if (block.signature) {
        result.signature = block.signature;
      }
      return result;
    }

    // New LangChain standardized format: { type: "reasoning", reasoning: "..." }
    if (block.type === 'reasoning' && block.reasoning) {
      return {
        text: block.reasoning,
        type: 'text',
        index: block.index ?? 0,
      }
    }

    // OpenAI Responses API v1 format: { type: "reasoning", summary: [{ text: "..." }] }
    if (block.type === 'reasoning' && block.summary?.[0]?.text) {
      return {
        type: 'text',
        text: block.summary[0].text,
        index: block.summary[0].index ?? 0,
      }
    }
  }

  // OpenAI legacy format via additional_kwargs
  if (eventData.chunk?.additional_kwargs?.reasoning?.summary?.[0]) {
    const data = eventData.chunk.additional_kwargs.reasoning.summary[0]
    if (!data || !data.text) return null
    return {
      type: 'text',
      text: data.text,
      index: data.index ?? 0,
    }
  }

  return null
}

/**
 * Resolves encrypted reasoning content from Anthropic responses.
 * This handles:
 * - `signature` fields on thinking blocks (cryptographic verification)
 * - `redacted_thinking` blocks with encrypted `data` (redacted chain-of-thought)
 */
export function resolveEncryptedReasoningContent(eventData: any): string | null {
  const content = eventData.chunk?.content

  if (!content || !Array.isArray(content) || !content.length || !content[0]) {
    return null;
  }

  // Anthropic redacted_thinking block: { type: "redacted_thinking", data: "..." }
  if (content[0].type === 'redacted_thinking' && content[0].data) {
    return content[0].data;
  }

  return null;
}

export function resolveMessageContent(content?: LangGraphMessage['content']): string | null {
  if (!content) return null;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content) && content.length) {
    const contentText = content.find(c => c.type === 'text')?.text
    return contentText ?? null;
  }

  return null
}
