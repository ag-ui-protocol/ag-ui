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
  randomUUID,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  LanguageModel,
  ModelMessage,
  stepCountIs,
  streamText,
  tool as createVercelAISDKTool,
  ToolChoice,
  ToolSet,
} from "ai";
import { z } from "zod";

type VercelUserContent = Extract<ModelMessage, { role: "user" }>["content"];
type VercelUserArrayContent = Extract<VercelUserContent, any[]>;
type VercelUserPart =
  VercelUserArrayContent extends Array<infer Part> ? Part : never;

type VercelAssistantContent = Extract<
  ModelMessage,
  { role: "assistant" }
>["content"];
type VercelAssistantArrayContent = Extract<VercelAssistantContent, any[]>;
type VercelAssistantPart =
  VercelAssistantArrayContent extends Array<infer Part> ? Part : never;

type VercelToolContent = Extract<ModelMessage, { role: "tool" }>["content"];
type VercelToolArrayContent = Extract<VercelToolContent, any[]>;
type VercelToolPart =
  VercelToolArrayContent extends Array<infer Part> ? Part : never;

const toVercelUserParts = (
  inputContent: Message["content"],
): VercelUserPart[] => {
  if (!Array.isArray(inputContent)) {
    return [];
  }

  const parts: VercelUserPart[] = [];

  for (const part of inputContent) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text } as VercelUserPart);
    }
  }

  return parts;
};

const toVercelUserContent = (
  content: Message["content"],
): VercelUserContent => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  const parts = toVercelUserParts(content);
  if (parts.length === 0) {
    return "";
  }

  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  return parts;
};

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

  constructor(private config: VercelAISDKAgentConfig) {
    const { model, maxSteps, toolChoice, ...rest } = config;
    super({ ...rest });
    this.model = model;
    this.maxSteps = maxSteps ?? 1;
    this.toolChoice = toolChoice ?? "auto";
  }

  public clone() {
    return new VercelAISDKAgent(this.config);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const finalMessages: Message[] = [...input.messages];

    return new Observable<ProcessedEvent>((subscriber) => {
      let cancelled = false;

      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as RunStartedEvent);

      const messageId = randomUUID();
      const assistantMessage: AssistantMessage = {
        id: messageId,
        role: "assistant",
        content: "",
        toolCalls: [],
      };
      finalMessages.push(assistantMessage);
      const seenToolCalls = new Set<string>();

      const processStream = async () => {
        try {
          const response = streamText({
            model: this.model,
            messages: convertMessagesToVercelAISDKMessages(input.messages),
            tools: convertToolsToVercelAISDKTools(input.tools),
            stopWhen: stepCountIs(this.maxSteps),
            toolChoice: this.toolChoice,
          });

          for await (const streamPart of response.fullStream) {
            if (cancelled) {
              return;
            }

            if (streamPart.type === "text-delta") {
              assistantMessage.content = `${assistantMessage.content ?? ""}${streamPart.text}`;
              const event: TextMessageChunkEvent = {
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId,
                delta: streamPart.text,
              };
              subscriber.next(event);
            } else if (streamPart.type === "tool-call") {
              if (!seenToolCalls.has(streamPart.toolCallId)) {
                seenToolCalls.add(streamPart.toolCallId);

                const toolCall: ToolCall = {
                  id: streamPart.toolCallId,
                  type: "function",
                  function: {
                    name: streamPart.toolName,
                    arguments: safeJsonStringify(streamPart.input),
                  },
                };
                assistantMessage.toolCalls = [...(assistantMessage.toolCalls ?? []), toolCall];

                const startEvent: ToolCallStartEvent = {
                  type: EventType.TOOL_CALL_START,
                  parentMessageId: messageId,
                  toolCallId: streamPart.toolCallId,
                  toolCallName: streamPart.toolName,
                };
                subscriber.next(startEvent);

                const argsEvent: ToolCallArgsEvent = {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: streamPart.toolCallId,
                  delta: safeJsonStringify(streamPart.input),
                };
                subscriber.next(argsEvent);

                const endEvent: ToolCallEndEvent = {
                  type: EventType.TOOL_CALL_END,
                  toolCallId: streamPart.toolCallId,
                };
                subscriber.next(endEvent);
              }
            } else if (streamPart.type === "tool-result") {
              const toolMessage: ToolMessage = {
                role: "tool",
                id: randomUUID(),
                toolCallId: streamPart.toolCallId,
                content: safeJsonStringify(streamPart.output),
              };
              finalMessages.push(toolMessage);
            } else if (streamPart.type === "error") {
              throw streamPart.error;
            }
          }

          if (cancelled) {
            return;
          }

          const event: MessagesSnapshotEvent = {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: finalMessages,
          };
          subscriber.next(event);

          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as RunFinishedEvent);
          subscriber.complete();
        } catch (error) {
          if (!cancelled) {
            subscriber.error(error);
          }
        }
      };

      void processStream();

      return () => {
        cancelled = true;
      };
    });
  }
}

export function convertMessagesToVercelAISDKMessages(
  messages: Message[],
): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: VercelAssistantPart[] = message.content
        ? ([{ type: "text", text: message.content }] as VercelAssistantPart[])
        : [];

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
        content: parts.length > 0 ? parts : "",
      });
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: toVercelUserContent(message.content),
      });
    } else if (message.role === "system" || message.role === "developer") {
      result.push({
        role: "system",
        content: typeof message.content === "string" ? message.content : "",
      });
    } else if (message.role === "tool") {
      const toolName = resolveToolName(messages, message.toolCallId);

      result.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName,
            output: {
              type: "text",
              value: message.content,
            },
          },
        ] as VercelToolPart[],
      });
    }
  }

  return result;
}

export function convertJsonSchemaToZodSchema(
  jsonSchema: any,
  required: boolean,
): z.ZodSchema {
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

    let schema = z.object(spec);
    if (jsonSchema.description) {
      schema = schema.describe(jsonSchema.description);
    }

    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "string") {
    let schema = z.string();
    if (jsonSchema.description) {
      schema = schema.describe(jsonSchema.description);
    }

    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "number" || jsonSchema.type === "integer") {
    let schema = z.number();
    if (jsonSchema.description) {
      schema = schema.describe(jsonSchema.description);
    }

    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "boolean") {
    let schema = z.boolean();
    if (jsonSchema.description) {
      schema = schema.describe(jsonSchema.description);
    }

    return required ? schema : schema.optional();
  } else if (jsonSchema.type === "array") {
    let itemSchema = convertJsonSchemaToZodSchema(jsonSchema.items, true);
    let schema = z.array(itemSchema);
    if (jsonSchema.description) {
      schema = schema.describe(jsonSchema.description);
    }

    return required ? schema : schema.optional();
  }
  throw new Error("Invalid JSON schema");
}

export function convertToolsToVercelAISDKTools(
  tools: RunAgentInput["tools"],
): ToolSet {
  const convertedTools: ToolSet = {};

  for (const tool of tools) {
    (convertedTools as Record<string, unknown>)[tool.name] = createVercelAISDKTool({
      description: tool.description,
      inputSchema: convertJsonSchemaToZodSchema(tool.parameters, true) as any,
    });
  }

  return convertedTools;
}

// Keep the typo'd export for backward compatibility.
export const convertToolToVerlAISDKTools = convertToolsToVercelAISDKTools;

const safeJsonParse = (input: string): unknown => {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
};

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const resolveToolName = (messages: Message[], toolCallId: string): string => {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.id === toolCallId) {
        return toolCall.function.name;
      }
    }
  }

  return "unknown";
};
