import type { Message } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { MastraClient } from "@mastra/client-js";
import type { CoreMessage, Mastra } from "@mastra/core";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { MastraAgent } from "./mastra";

export function convertAGUIMessagesToMastra(messages: Message[]): CoreMessage[] {
  const result: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];

      if (message.content) {
        parts.push({ type: "text", text: message.content });
      }

      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: safeJsonParse(toolCall.function.arguments),
        });
      }

      result.push({
        role: "assistant",
        content: parts,
      });
      continue;
    }

    if (message.role === "user") {
      result.push({
        role: "user",
        content: message.content ?? "",
      });
      continue;
    }

    if (message.role === "tool") {
      const toolName = findToolNameForMessage(messages, message.toolCallId) ?? "unknown";

      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName,
            output: toToolResultOutput(message.content),
          },
        ],
      });
      continue;
    }
  }

  return result as unknown as CoreMessage[];
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

function safeJsonParse(value: string | undefined): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toToolResultOutput(content: string | undefined) {
  if (!content) {
    return { type: "text" as const, value: "" };
  }

  const parsed = safeJsonParse(content);
  if (typeof parsed === "string") {
    return { type: "text" as const, value: parsed };
  }

  return { type: "json" as const, value: parsed };
}

function findToolNameForMessage(messages: Message[], toolCallId: string | undefined) {
  if (!toolCallId) {
    return undefined;
  }

  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }

    for (const toolCall of msg.toolCalls ?? []) {
      if (toolCall.id === toolCallId) {
        return toolCall.function.name;
      }
    }
  }

  return undefined;
}
