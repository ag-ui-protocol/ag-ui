import {
  AgentConfig,
  AbstractAgent,
  EventType,
  BaseEvent,
  Message,
  AssistantMessage,
  RunAgentInput,
  MessagesSnapshotEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCall,
  ToolMessage,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  ModelMessage,
  LanguageModel,
  streamText,
  tool as createVercelAISDKTool,
  Tool,
  ToolChoice,
  ToolSet,
  stepCountIs,
} from "ai";
import { randomUUID } from "@ag-ui/client";
import { z } from "zod";

type ProcessedEvent =
  | MessagesSnapshotEvent
  | RunFinishedEvent
  | RunStartedEvent
  | TextMessageChunkEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallStartEvent;

interface VercelAISDKAgentConfig extends AgentConfig {
  model: LanguageModel;
  maxSteps?: number;
  toolChoice?: ToolChoice<Record<string, unknown>>;
}

export class VercelAISDKAgent extends AbstractAgent {
  model: LanguageModel;
  maxSteps: number;
  toolChoice: ToolChoice<Record<string, unknown>>;
  constructor({ model, maxSteps, toolChoice, ...rest }: VercelAISDKAgentConfig) {
    super({ ...rest });
    this.model = model;
    this.maxSteps = maxSteps ?? 1;
    this.toolChoice = toolChoice ?? "auto";
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const finalMessages: Message[] = input.messages;

    return new Observable<ProcessedEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunStartedEvent);

      const toolSet = convertToolToVercelAISDKTools(input.tools);
      const stopCondition = this.maxSteps > 0 ? stepCountIs(this.maxSteps) : undefined;

      const response = streamText({
        model: this.model,
        messages: convertMessagesToModelMessages(input.messages),
        toolChoice: this.toolChoice,
        ...(Object.keys(toolSet).length > 0 ? { tools: toolSet } : {}),
        ...(stopCondition ? { stopWhen: stopCondition } : {}),
      });

      let messageId = randomUUID();
      let assistantMessage: AssistantMessage = {
        id: messageId,
        role: "assistant",
        content: "",
        toolCalls: [],
      };
      finalMessages.push(assistantMessage);

      let hasCompleted = false;
      const seenToolCallIds = new Set<string>();

      const finalizeRun = () => {
        if (hasCompleted) {
          return;
        }
        hasCompleted = true;

        const snapshotEvent: MessagesSnapshotEvent = {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: finalMessages,
        };
        subscriber.next(snapshotEvent);

        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as RunFinishedEvent);

        subscriber.complete();
      };

      const processStream = async () => {
        try {
          for await (const part of response.fullStream) {
            switch (part.type) {
              case "text-delta": {
                if (!part.text) {
                  break;
                }
                assistantMessage.content += part.text;
                const event: TextMessageChunkEvent = {
                  type: EventType.TEXT_MESSAGE_CHUNK,
                  role: "assistant",
                  messageId,
                  delta: part.text,
                };
                subscriber.next(event);
                break;
              }
              case "tool-call": {
                if (seenToolCallIds.has(part.toolCallId)) {
                  break;
                }
                seenToolCallIds.add(part.toolCallId);
                const argumentsJson = safeStringify(part.input);
                let toolCall: ToolCall = {
                  id: part.toolCallId,
                  type: "function",
                  function: {
                    name: part.toolName,
                    arguments: argumentsJson,
                  },
                };
                assistantMessage.toolCalls!.push(toolCall);

                const startEvent: ToolCallStartEvent = {
                  type: EventType.TOOL_CALL_START,
                  parentMessageId: messageId,
                  toolCallId: part.toolCallId,
                  toolCallName: part.toolName,
                };
                subscriber.next(startEvent);

                const argsEvent: ToolCallArgsEvent = {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: part.toolCallId,
                  delta: argumentsJson,
                };
                subscriber.next(argsEvent);

                const endEvent: ToolCallEndEvent = {
                  type: EventType.TOOL_CALL_END,
                  toolCallId: part.toolCallId,
                };
                subscriber.next(endEvent);
                break;
              }
              case "tool-result": {
                if (part.preliminary) {
                  break;
                }
                const toolMessage: ToolMessage = {
                  role: "tool",
                  id: randomUUID(),
                  toolCallId: part.toolCallId,
                  content: safeStringify(part.output),
                };
                finalMessages.push(toolMessage);
                break;
              }
              case "tool-error": {
                subscriber.error(part.error ?? new Error(`Tool ${part.toolName} failed`));
                return;
              }
              case "error": {
                subscriber.error(part.error ?? new Error("Stream error"));
                return;
              }
              case "finish": {
                finalizeRun();
                return;
              }
              default:
                break;
            }
          }
          finalizeRun();
        } catch (error) {
          subscriber.error(error);
        }
      };

      processStream();

      return () => {};
    });
  }
}

export function convertMessagesToModelMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: any[] = message.content ? [{ type: "text", text: message.content }] : [];
      for (const toolCall of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
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
            output: parseToolMessageContent(message.content),
          },
        ],
      });
    }
  }

  return result;
}

export function convertJsonSchemaToZodSchema(jsonSchema: any, required: boolean): z.ZodTypeAny {
  if (jsonSchema.type === "object") {
    const spec: Record<string, z.ZodTypeAny> = {};

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
  const toolSet: Record<string, unknown> = {};

  for (const tool of tools) {
    const inputSchema = convertJsonSchemaToZodSchema(tool.parameters, true) as z.ZodTypeAny;
    const toolDefinition = {
      description: tool.description,
      inputSchema,
      outputSchema: z.any(),
    } as unknown;
    toolSet[tool.name] = createVercelAISDKTool(toolDefinition as any);
  }

  return toolSet as ToolSet;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function parseToolMessageContent(content: string) {
  if (!content) {
    return { type: "text" as const, value: "" };
  }

  try {
    const parsed = JSON.parse(content);
    return { type: "json" as const, value: parsed };
  } catch {
    return { type: "text" as const, value: content };
  }
}
