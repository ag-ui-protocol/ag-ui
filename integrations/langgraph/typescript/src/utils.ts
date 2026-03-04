import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { State, SchemaKeys, LangGraphReasoning } from "./types";
import { Message, ToolCall, TextInputContent, BinaryInputContent, InputContent , UserMessage} from "@ag-ui/client";

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

/**
 * Convert LangChain's multimodal content to AG-UI format
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
          type: "binary",
          mimeType,
          data: data || "",
        });
      } else {
        // Regular URL or ID
        aguiContent.push({
          type: "binary",
          mimeType: "image/png", // Default MIME type
          url: imageUrl,
        });
      }
    }
  }

  return aguiContent;
}

/**
 * Convert AG-UI multimodal content to LangChain's format
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
    } else if (item.type === "binary") {
      // LangChain uses image_url format (OpenAI-style)
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
        continue; // Skip if no source is provided
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

/**
 * Flatten multimodal content into plain text.
 * Used for backwards compatibility or when multimodal is not supported.
 */
function flattenUserContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];

  for (const item of content) {
    if (item.type === "text" && "text" in item) {
      if (item.text) {
        parts.push(item.text);
      }
    } else if (item.type === "binary" && "mimeType" in item) {
      // Add descriptive placeholder for binary content
      const binaryItem = item as BinaryInputContent;
      if (binaryItem.filename) {
        parts.push(`[Binary content: ${binaryItem.filename}]`);
      } else if (binaryItem.url) {
        parts.push(`[Binary content: ${binaryItem.url}]`);
      } else {
        parts.push(`[Binary content: ${binaryItem.mimeType}]`);
      }
    }
  }

  return parts.join("\n");
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
