import type { InputContent, InputContentDataSource, InputContentUrlSource, Message } from "@ag-ui/client";
import { AbstractAgent, randomUUID } from "@ag-ui/client";
import { MastraClient } from "@mastra/client-js";
import type { Mastra } from "@mastra/core";
import type { CoreMessage } from "@mastra/core/llm";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MastraAgent } from "./mastra";

function mediaSourceToUrl(source: InputContentDataSource | InputContentUrlSource): string {
  if (source.type === "data") {
    return `data:${source.mimeType};base64,${source.value}`;
  }
  return source.value;
}

const toMastraTextContent = (content: Message["content"]): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  type TextInput = Extract<InputContent, { type: "text" }>;

  const textParts = content
    .filter((part): part is TextInput => part.type === "text")
    .map((part: TextInput) => part.text.trim())
    .filter(Boolean);

  return textParts.join("\n");
};

const toMastraContent = (content: Message["content"]): string | any[] => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const hasNonTextParts = content.some((part) => part.type !== "text");

  if (!hasNonTextParts) {
    // Backwards compat: text-only arrays return a joined string
    type TextInput = Extract<InputContent, { type: "text" }>;
    const textParts = content
      .filter((part): part is TextInput => part.type === "text")
      .map((part: TextInput) => part.text.trim())
      .filter(Boolean);
    return textParts.join("\n");
  }

  // Structured content array with mixed types
  const parts: any[] = [];
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
          mimeType: part.source.mimeType ?? "application/octet-stream",
        });
        break;
      case "binary": {
        // Deprecated BinaryInputContent
        const binaryPart = part as Extract<InputContent, { type: "binary" }>;
        if (binaryPart.url) {
          parts.push({ type: "image", image: binaryPart.url });
        } else if (binaryPart.data && binaryPart.mimeType) {
          parts.push({
            type: "image",
            image: `data:${binaryPart.mimeType};base64,${binaryPart.data}`,
          });
        } else {
          console.warn("[toMastraContent] Dropping BinaryInputContent: no url or data provided");
        }
        break;
      }
      default:
        console.warn(`[toMastraContent] Unknown content type "${part.type}"; skipping`);
        break;
    }
  }
  return parts;
};

export function convertAGUIMessagesToMastra(messages: Message[]): CoreMessage[] {
  // Preserve AG-UI message IDs on the CoreMessage objects. Although CoreMessage
  // does not officially type an `id` field, Mastra's AIV4Adapter.fromCoreMessage
  // reads `id` when present (see @mastra/core AIV4Adapter.fromCoreMessage).
  // Preserving IDs enables Mastra's MessageHistory processor to deduplicate:
  //   - processInput filters historical messages whose IDs match the input IDs
  //   - storage.saveMessages upserts by ID, so re-sent history won't duplicate
  // Without this, CopilotKit re-sending the full thread on every turn causes
  // message duplication in Mastra-backed storage.
  const result: CoreMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const assistantContent = toMastraTextContent(message.content);
      const parts: any[] = [];
      if (assistantContent) {
        parts.push({ type: "text", text: assistantContent });
      }
      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
        });
      }
      result.push({
        id: message.id,
        role: "assistant",
        content: parts,
      } as CoreMessage);
    } else if (message.role === "user") {
      const userContent = toMastraContent(message.content);
      result.push({
        id: message.id,
        role: "user",
        content: userContent,
      } as CoreMessage);
    } else if (message.role === "tool") {
      let toolName = "unknown";
      for (const msg of messages) {
        if (msg.role === "assistant") {
          for (const toolCall of msg.toolCalls ?? []) {
            if (toolCall.id === message.toolCallId) {
              toolName = toolCall.function.name;
              break;
            }
          }
        }
      }
      result.push({
        id: message.id,
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: toolName,
            result: message.content,
          },
        ],
      } as CoreMessage);
    }
  }

  return result;
}

/**
 * Converts Mastra MastraDBMessage[] (V2 format) to AG-UI Message[] format.
 * Used to emit MESSAGES_SNAPSHOT events so frontends (e.g. CopilotKit) can
 * synchronize thread history without re-sending all messages.
 *
 * MastraDBMessage uses a V2 parts-based format:
 *   { id, role, content: { format: 2, parts: [...] } }
 *
 * Each part has a `type` (e.g. "text", "tool-invocation") with type-specific fields.
 */
/**
 * Parse a string payload that may be either a `data:<mime>;base64,<raw>` URL
 * or a plain URL into an AG-UI content source. The forward converter
 * (`toMastraContent` / `mediaSourceToUrl`) always produces a data URL for
 * `type: "data"` sources and a plain URL for `type: "url"` sources, so we
 * reverse that here to recover the original shape. `mimeTypeHint` is used
 * when the payload is a plain URL (no mime embedded).
 */
function parseMediaSource(
  value: string,
  mimeTypeHint?: string,
): InputContentDataSource | InputContentUrlSource {
  const dataUrlMatch = /^data:([^;,]+)(?:;([^,]+))?,(.*)$/.exec(value);
  if (dataUrlMatch) {
    const [, mime, encoding, payload] = dataUrlMatch;
    // Only base64 data URLs round-trip cleanly to AG-UI's { type: "data" }
    // shape (which expects raw base64). Anything else, hand back as a url.
    if (encoding === "base64") {
      return { type: "data", value: payload, mimeType: mime };
    }
    return { type: "url", value, mimeType: mime };
  }
  return {
    type: "url",
    value,
    mimeType: mimeTypeHint ?? "application/octet-stream",
  };
}

/**
 * Map a Mastra V2 media part back to an AG-UI InputContent entry.
 *
 * Handles both shapes emitted by the forward converter (`toMastraContent`):
 *   - `{ type: "image", image: <data-url | url> }`
 *   - `{ type: "file", mimeType, data: <data-url | url> | url: <url> }`
 *
 * Returns null when the part can't be represented.
 */
function mediaPartToAGUIInputContent(part: {
  type?: string;
  mimeType?: string;
  data?: string;
  url?: string;
  image?: string;
}): InputContent | null {
  if (part.type === "image") {
    // Forward converter emits `{ type: "image", image: <url-or-data-url> }`.
    // The mime type for plain URLs isn't recoverable, so default to image/*.
    const raw = part.image;
    if (!raw) return null;
    const source = parseMediaSource(raw, "image/*");
    return { type: "image", source };
  }

  if (part.type === "file") {
    const hintedMime = part.mimeType ?? "application/octet-stream";
    let source: InputContentDataSource | InputContentUrlSource | null = null;
    if (part.data) {
      source = parseMediaSource(part.data, hintedMime);
      // If the hinted mime conflicts with a decoded data-URL mime, trust the
      // hint from the part (it's authoritative in storage).
      if (source.type === "data" && part.mimeType) {
        source = { ...source, mimeType: part.mimeType };
      }
    } else if (part.url) {
      source = { type: "url", value: part.url, mimeType: hintedMime };
    }
    if (!source) return null;

    const mime = source.mimeType ?? hintedMime;
    if (mime.startsWith("image/")) return { type: "image", source };
    if (mime.startsWith("audio/")) return { type: "audio", source };
    if (mime.startsWith("video/")) return { type: "video", source };
    return { type: "document", source };
  }

  return null;
}

export function convertMastraMessagesToAGUI(messages: { id: string; role: string; content: { parts?: any[] } }[]): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    const parts = message.content?.parts ?? [];

    if (message.role === "user") {
      // Preserve multimodal content. Use a string when the message is text-only
      // (backwards-compat with AG-UI clients that expect string content), and
      // an InputContent[] when any non-text part is present.
      const inputContent: InputContent[] = [];
      for (const part of parts) {
        if (part.type === "text") {
          if (part.text) inputContent.push({ type: "text", text: part.text });
        } else if (part.type === "file" || part.type === "image") {
          const mapped = mediaPartToAGUIInputContent(part);
          if (mapped) inputContent.push(mapped);
        }
      }

      const hasNonText = inputContent.some((c) => c.type !== "text");
      if (hasNonText) {
        result.push({
          id: message.id,
          role: "user",
          content: inputContent,
        } as Message);
      } else {
        const text = inputContent
          .filter((c): c is Extract<InputContent, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        result.push({
          id: message.id,
          role: "user",
          content: text,
        } as Message);
      }
    } else if (message.role === "assistant") {
      // AG-UI AssistantMessage.content is `string | undefined`, so non-text
      // assistant parts (file/reasoning/etc.) cannot be faithfully represented
      // and are intentionally skipped. Text parts are concatenated in order.
      const textSegments: string[] = [];
      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];
      const toolResults: Array<{ toolCallId: string; result: any }> = [];

      for (const part of parts) {
        if (part.type === "text") {
          if (part.text) textSegments.push(part.text);
        } else if (part.type === "tool-invocation" || part.type === "tool-call") {
          const toolCallId = part.toolCallId ?? part.id ?? randomUUID();
          const toolName = part.toolName ?? part.name ?? "unknown";
          const args = part.args ?? {};
          toolCalls.push({
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: typeof args === "string" ? args : JSON.stringify(args),
            },
          });
          if (part.type === "tool-invocation" && part.state === "result" && part.result !== undefined) {
            toolResults.push({
              toolCallId,
              result: part.result,
            });
          }
        }
      }

      const textContent = textSegments.join("");
      if (textContent || toolCalls.length > 0) {
        result.push({
          id: message.id,
          role: "assistant",
          content: textContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        } as Message);
      }

      // Push tool result messages after the assistant message with stable IDs
      // derived from the parent message + tool call, so repeated snapshots
      // don't produce new IDs for the same logical tool result.
      for (const tr of toolResults) {
        result.push({
          id: `${message.id}:${tr.toolCallId}:result`,
          role: "tool",
          content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
          toolCallId: tr.toolCallId,
        } as Message);
      }
    }
    // System messages are skipped — AG-UI MESSAGES_SNAPSHOT only needs user/assistant/tool
  }

  return result;
}

export interface GetRemoteAgentsOptions {
  mastraClient: MastraClient;
  resourceId: string;
}

export async function getRemoteAgents({
  mastraClient,
  resourceId,
}: GetRemoteAgentsOptions): Promise<Record<string, AbstractAgent>> {
  const agents = await mastraClient.listAgents();

  return Object.entries(agents).reduce(
    (acc, [agentId]) => {
      const agent = mastraClient.getAgent(agentId);

      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
      });

      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );
}

export interface GetLocalAgentsOptions {
  mastra: Mastra;
  resourceId: string;
  requestContext?: RequestContext;
}

export function getLocalAgents({
  mastra,
  resourceId,
  requestContext,
}: GetLocalAgentsOptions): Record<string, AbstractAgent> {
  const agents = mastra.listAgents() || {};

  const agentAGUI = Object.entries(agents).reduce(
    (acc, [agentId, agent]) => {
      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
        requestContext,
      });
      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );

  return agentAGUI;
}

export interface GetLocalAgentOptions {
  mastra: Mastra;
  agentId: string;
  resourceId: string;
  requestContext?: RequestContext;
}

export function getLocalAgent({
  mastra,
  agentId,
  resourceId,
  requestContext,
}: GetLocalAgentOptions) {
  const agent = mastra.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }
  return new MastraAgent({
    agentId,
    agent,
    resourceId,
    requestContext,
  }) as AbstractAgent;
}

export interface GetNetworkOptions {
  mastra: Mastra;
  networkId: string;
  resourceId: string;
  requestContext?: RequestContext;
}

export function getNetwork({ mastra, networkId, resourceId, requestContext }: GetNetworkOptions) {
  const network = mastra.getAgent(networkId);
  if (!network) {
    throw new Error(`Network ${networkId} not found`);
  }
  return new MastraAgent({
    agentId: network.name!,
    agent: network as unknown as LocalMastraAgent,
    resourceId,
    requestContext,
  }) as AbstractAgent;
}
