import type { InputContent, InputContentDataSource, InputContentUrlSource, Message } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
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
        role: "assistant",
        content: parts,
      });
    } else if (message.role === "user") {
      const userContent = toMastraContent(message.content);
      result.push({
        role: "user",
        content: userContent,
      });
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
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: toolName,
            result: message.content,
          },
        ],
      });
    }
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
