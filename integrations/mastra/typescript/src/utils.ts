import type { InputContent, Message } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { MastraClient } from "@mastra/client-js";
import type { CoreMessage, Mastra } from "@mastra/core";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { MastraAgent } from "./mastra";

const toMastraTextContent = (content: Message["content"]): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  const textParts = content
    .filter((part): part is Extract<InputContent, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);

  return textParts.join("\n");
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
      const userContent = toMastraTextContent(message.content);
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
  resourceId?: string;
}

export async function getRemoteAgents({
  mastraClient,
  resourceId,
}: GetRemoteAgentsOptions): Promise<Record<string, AbstractAgent>> {
  const agents = await mastraClient.getAgents();

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
  resourceId?: string;
  runtimeContext?: RuntimeContext;
}

export function getLocalAgents({
  mastra,
  resourceId,
  runtimeContext,
}: GetLocalAgentsOptions): Record<string, AbstractAgent> {
  const agents = mastra.getAgents() || {};

  const agentAGUI = Object.entries(agents).reduce(
    (acc, [agentId, agent]) => {
      acc[agentId] = new MastraAgent({
        agentId,
        agent,
        resourceId,
        runtimeContext,
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
  resourceId?: string;
  runtimeContext?: RuntimeContext;
}

export function getLocalAgent({
  mastra,
  agentId,
  resourceId,
  runtimeContext,
}: GetLocalAgentOptions) {
  const agent = mastra.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }
  return new MastraAgent({
    agentId,
    agent,
    resourceId,
    runtimeContext,
  }) as AbstractAgent;
}

export interface GetNetworkOptions {
  mastra: Mastra;
  networkId: string;
  resourceId?: string;
  runtimeContext?: RuntimeContext;
}

export function getNetwork({ mastra, networkId, resourceId, runtimeContext }: GetNetworkOptions) {
  const network = mastra.getAgent(networkId);
  if (!network) {
    throw new Error(`Network ${networkId} not found`);
  }
  return new MastraAgent({
    agentId: network.name!,
    agent: network as unknown as LocalMastraAgent,
    resourceId,
    runtimeContext,
  }) as AbstractAgent;
}
