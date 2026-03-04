import type { InputContent, Message, RunHistory } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import type { MastraDBMessage } from "@mastra/core/memory";
import { MastraClient } from "@mastra/client-js";
import type { Mastra } from "@mastra/core";
import type { CoreMessage } from "@mastra/core/llm";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MastraAgent } from "./mastra";

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
        mastraClient,
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

/**
 * Converts MastraDBMessage[] (V2 format with content.parts[]) to AG-UI Message[].
 *
 * One MastraDBMessage can expand to multiple AG-UI messages. For example, an
 * assistant message with tool-invocation parts produces an AssistantMessage
 * (with toolCalls[]) plus a ToolMessage for each completed tool invocation.
 */
export function convertMastraDBMessagesToAGUI(
  messages: MastraDBMessage[],
): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    const parts = msg.content?.parts ?? [];

    if (msg.role === "user") {
      const textParts = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text as string);
      result.push({
        id: msg.id,
        role: "user",
        content: textParts.join("\n") || "",
      });
    } else if (msg.role === "assistant") {
      const textParts = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text as string);
      const content = textParts.join("\n") || "";

      // Collect tool invocations from tool-invocation parts
      const toolInvocationParts = parts.filter(
        (p: any) => p.type === "tool-invocation",
      );

      // Also collect from dynamic-tool parts
      const dynamicToolParts = parts.filter(
        (p: any) => p.type === "dynamic-tool",
      );

      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];

      const toolMessages: Message[] = [];

      for (const part of toolInvocationParts) {
        const inv = (part as any).toolInvocation;
        if (!inv) continue;

        toolCalls.push({
          id: inv.toolCallId,
          type: "function",
          function: {
            name: inv.toolName,
            arguments: JSON.stringify(inv.args ?? {}),
          },
        });

        // If the tool invocation has a result, emit a ToolMessage
        if (inv.state === "result" && inv.result !== undefined) {
          toolMessages.push({
            id: inv.toolCallId,
            role: "tool",
            toolCallId: inv.toolCallId,
            content: JSON.stringify(inv.result),
          });
        }
      }

      for (const part of dynamicToolParts) {
        const dp = part as any;
        if (!dp.toolCallId) continue;

        toolCalls.push({
          id: dp.toolCallId,
          type: "function",
          function: {
            name: dp.toolName,
            arguments: JSON.stringify(dp.input ?? {}),
          },
        });

        if (
          dp.state === "output-available" &&
          dp.output !== undefined
        ) {
          toolMessages.push({
            id: dp.toolCallId,
            role: "tool",
            toolCallId: dp.toolCallId,
            content: JSON.stringify(dp.output),
          });
        }
      }

      const assistantMsg: Message = {
        id: msg.id,
        role: "assistant",
        content: content || undefined,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
      result.push(assistantMsg);
      result.push(...toolMessages);
    } else if (msg.role === "system") {
      const textParts = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text as string);
      result.push({
        id: msg.id,
        role: "system",
        content: textParts.join("\n") || "",
      });
    }
  }

  return result;
}

/**
 * Groups a flat Message[] into RunHistory[] by splitting on user-message boundaries.
 * Each run starts with a user message, and its runId is the user message's id.
 */
export function groupMessagesIntoRuns(messages: Message[]): RunHistory[] {
  const runs: RunHistory[] = [];
  let currentMessages: Message[] = [];
  let currentRunId: string | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      // If there are accumulated messages, push the previous run
      if (currentMessages.length > 0) {
        runs.push({ runId: currentRunId!, messages: currentMessages });
      }
      currentRunId = msg.id;
      currentMessages = [msg];
    } else {
      if (!currentRunId) {
        // Messages before any user message (e.g., system) — start a run with a generated id
        currentRunId = msg.id;
      }
      currentMessages.push(msg);
    }
  }

  // Push the last run
  if (currentMessages.length > 0) {
    runs.push({ runId: currentRunId!, messages: currentMessages });
  }

  return runs;
}
