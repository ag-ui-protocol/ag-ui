import { A2AClient, AgentCard, SendMessageResponse, SendMessageSuccessResponse } from "@a2a-js/sdk";
import { BaseEvent, EventType, Message, RunAgentInput, TextMessageChunkEvent } from "@ag-ui/client";
import { CoreMessage, LanguageModel, processDataStream, streamText, ToolSet } from "ai";
import { tool, generateText } from "ai";
import { z } from "zod";

export const createSystemPrompt = (agentCards: AgentCard[], additionalInstructions?: string) => `
**Role:** You are an expert Routing Delegator. Your primary function is to accurately delegate user inquiries to the appropriate specialized remote agents.

**Instructions:** 
YOU MUST NOT literally repeat what the agent responds unless asked to do so. Add context, summarize the conversation, and add your own thoughts.
YOU MUST engage in multi-turn conversations with the agents. NEVER ask the user for permission to engage multiple times with the same agent.
YOU MUST ALWAYS, UNDER ALL CIRCUMSTANCES, COMMUNICATE WITH ALL AGENTS NECESSARY TO COMPLETE THE TASK.
NEVER STOP COMMUNICATING WITH THE AGENTS UNTIL THE TASK IS COMPLETED.

If you have tools available to display information to the user, you MUST use them.

${additionalInstructions ? `**Additional Instructions:**\n${additionalInstructions}` : ""}

**Core Directives:**

* **Task Delegation:** Utilize the \`sendMessage\` function to assign actionable tasks to remote agents.
* **Contextual Awareness for Remote Agents:** If a remote agent repeatedly requests user confirmation, assume it lacks access to the full conversation history. In such cases, enrich the task description with all necessary contextual information relevant to that specific agent.
* **Autonomous Agent Engagement:** Never seek user permission before engaging with remote agents. If multiple agents are required to fulfill a request, connect with them directly without requesting user preference or confirmation.
* **Transparent Communication:** Always present the complete and detailed response from the remote agent to the user.
* **User Confirmation Relay:** If a remote agent asks for confirmation, and the user has not already provided it, relay this confirmation request to the user.
* **Focused Information Sharing:** Provide remote agents with only relevant contextual information. Avoid extraneous details.
* **No Redundant Confirmations:** Do not ask remote agents for confirmation of information or actions.
* **Tool Reliance:** Strictly rely on available tools to address user requests. Do not generate responses based on assumptions. If information is insufficient, request clarification from the user.
* **Prioritize Recent Interaction:** Focus primarily on the most recent parts of the conversation when processing requests.
* **Active Agent Prioritization:** If an active agent is already engaged, route subsequent related requests to that agent using the appropriate task update tool.

**Agent Roster:**

* Available Agents: 
${JSON.stringify(agentCards.map((agent) => ({ name: agent.name, description: agent.description })))}
`;

export function convertMessagesToVercelAISDKMessages(messages: Message[]): CoreMessage[] {
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

export function convertJsonSchemaToZodSchema(jsonSchema: any, required: boolean): z.ZodSchema {
  if (jsonSchema.type === "object") {
    const spec: { [key: string]: z.ZodSchema } = {};

    if (!jsonSchema.properties || !Object.keys(jsonSchema.properties).length) {
      return !required ? z.object(spec).optional() : z.object(spec);
    }

    for (const [key, value] of Object.entries(jsonSchema.properties)) {
      spec[key] = convertJsonSchemaToZodSchema(
        value,
        jsonSchema.required ? jsonSchema.required.includes(key) : false,
      );
    }
    let schema = z.object(spec).describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "string") {
    let schema = z.string().describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "number") {
    let schema = z.number().describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "boolean") {
    let schema = z.boolean().describe(jsonSchema.description);
    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "array") {
    let itemSchema = convertJsonSchemaToZodSchema(jsonSchema.items, true);
    let schema = z.array(itemSchema).describe(jsonSchema.description);
    return required ? schema : schema.optional();
  }
  throw new Error("Invalid JSON schema");
}

export function convertToolToVercelAISDKTools(tools: RunAgentInput["tools"]): ToolSet {
  return tools.reduce(
    (acc: ToolSet, t: RunAgentInput["tools"][number]) => ({
      ...acc,
      [t.name]: tool({
        description: t.description,
        parameters: convertJsonSchemaToZodSchema(t.parameters, true),
      }),
    }),
    {},
  );
}
