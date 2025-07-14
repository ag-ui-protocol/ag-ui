import type { Message } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  CopilotServiceAdapter,
  ExperimentalEmptyAdapter,
} from "@copilotkit/runtime";
import type { CoreMessage } from "@mastra/core";
import { registerApiRoute } from "@mastra/core/server";
import type { Mastra } from "@mastra/core";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "./mastra";

export function convertAGUIMessagesToMastra(messages: Message[]): CoreMessage[] {
  const result: CoreMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: any[] = message.content ? [{ type: "text", text: message.content }] : [];
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
      result.push({
        role: "user",
        content: message.content || "",
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

export function registerCopilotKit<T extends Record<string, any> | unknown = unknown>({
  path,
  resourceId,
  serviceAdapter = new ExperimentalEmptyAdapter(),
  agents,
  setContext,
}: {
  path: string;
  resourceId: string;
  serviceAdapter?: CopilotServiceAdapter;
  agents?: Record<string, AbstractAgent>;
  setContext?: (c: any, runtimeContext: RuntimeContext<T>) => void | Promise<void>;
}) {
  return registerApiRoute(path, {
    method: `ALL`,
    handler: async (c) => {
      const mastra = c.get("mastra");

      const runtimeContext = new RuntimeContext<T>();

      if (setContext) {
        await setContext(c, runtimeContext);
      }

      const aguiAgents =
        agents ||
        MastraAgent.getLocalAgents({
          resourceId,
          mastra,
          runtimeContext,
        });

      const runtime = new CopilotRuntime({
        agents: aguiAgents,
      });

      const handler = copilotRuntimeNodeHttpEndpoint({
        endpoint: path,
        runtime,
        serviceAdapter,
      });

      return handler.handle(c.req.raw, {});
    },
  });
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
  const networks = mastra.getNetworks() || [];

  const networkAGUI = networks.reduce(
    (acc, network) => {
      acc[network.name!] = new MastraAgent({
        agentId: network.name!,
        agent: network as unknown as LocalMastraAgent,
        resourceId,
        runtimeContext,
      });
      return acc;
    },
    {} as Record<string, AbstractAgent>,
  );

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

  return {
    ...agentAGUI,
    ...networkAGUI,
  };
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
  const network = mastra.getNetwork(networkId);
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
