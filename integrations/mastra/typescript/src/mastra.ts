import type {
  AgentConfig,
  BaseEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type { StorageThreadType } from "@mastra/core";
import { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { randomUUID } from "@ag-ui/client";
import { Observable } from "rxjs";
import { MastraClient } from "@mastra/client-js";
type RemoteMastraAgent = ReturnType<MastraClient["getAgent"]>;
import {
  convertAGUIMessagesToMastra,
  GetLocalAgentsOptions,
  getLocalAgents,
  getRemoteAgents,
  GetRemoteAgentsOptions,
  GetLocalAgentOptions,
  getLocalAgent,
  GetNetworkOptions,
  getNetwork,
} from "./utils";

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  runtimeContext?: RuntimeContext;
}

interface MastraAgentStreamOptions {
  onTextPart?: (text: string) => void;
  onFinishMessagePart?: () => void;
  onToolCallPart?: (streamPart: { toolCallId: string; toolName: string; args: unknown }) => void;
  onToolResultPart?: (streamPart: { toolCallId: string; output: unknown }) => void;
  onError?: (error: Error) => void;
  onRunFinished?: () => Promise<void>;
}

export class MastraAgent extends AbstractAgent {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  runtimeContext?: RuntimeContext;

  constructor({ agent, resourceId, runtimeContext, ...rest }: MastraAgentConfig) {
    super(rest);
    this.agent = agent;
    this.resourceId = resourceId;
    this.runtimeContext = runtimeContext ?? new RuntimeContext();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    let messageId = randomUUID();

    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        const runStartedEvent: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };

        subscriber.next(runStartedEvent);

        // Handle local agent memory management (from Mastra implementation)
        if (this.isLocalMastraAgent(this.agent)) {
          const memory = await this.agent.getMemory();

          if (memory && input.state && Object.keys(input.state || {}).length > 0) {
            let thread: StorageThreadType | null = await memory.getThreadById({
              threadId: input.threadId,
            });

            if (!thread) {
              thread = {
                id: input.threadId,
                title: "",
                metadata: {},
                resourceId: this.resourceId ?? input.threadId,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
            }

            const existingMemory = JSON.parse((thread.metadata?.workingMemory as string) ?? "{}");
            const { messages, ...rest } = input.state;
            const workingMemory = JSON.stringify({ ...existingMemory, ...rest });

            // Update thread metadata with new working memory
            await memory.saveThread({
              thread: {
                ...thread,
                metadata: {
                  ...thread.metadata,
                  workingMemory,
                },
              },
            });
          }
        }

        try {
          await this.streamMastraAgent(input, {
            onTextPart: (text) => {
              const event: TextMessageChunkEvent = {
                type: EventType.TEXT_MESSAGE_CHUNK,
                role: "assistant",
                messageId,
                delta: text,
              };
              subscriber.next(event);
            },
            onToolCallPart: (streamPart) => {
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
                delta: JSON.stringify(streamPart.args),
              };
              subscriber.next(argsEvent);

              const endEvent: ToolCallEndEvent = {
                type: EventType.TOOL_CALL_END,
                toolCallId: streamPart.toolCallId,
              };
              subscriber.next(endEvent);
            },
            onToolResultPart(streamPart) {
              const toolCallResultEvent: ToolCallResultEvent = {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: streamPart.toolCallId,
                content: safeStringify(streamPart.output),
                messageId: randomUUID(),
                role: "tool",
              };

              subscriber.next(toolCallResultEvent);
            },
            onFinishMessagePart: async () => {
              messageId = randomUUID();
            },
            onError: (error) => {
              console.error("error", error);
              // Handle error
              subscriber.error(error);
            },
            onRunFinished: async () => {
              if (this.isLocalMastraAgent(this.agent)) {
                try {
                  const memory = await this.agent.getMemory();
                  if (memory) {
                    const workingMemory = await memory.getWorkingMemory({
                      threadId: input.threadId,
                      memoryConfig: {
                        workingMemory: {
                          enabled: true,
                        },
                      },
                    });

                    if (typeof workingMemory === "string") {
                      const snapshot = JSON.parse(workingMemory);

                      if (snapshot && !("$schema" in snapshot)) {
                        const stateSnapshotEvent: StateSnapshotEvent = {
                          type: EventType.STATE_SNAPSHOT,
                          snapshot,
                        };

                        subscriber.next(stateSnapshotEvent);
                      }
                    }
                  }
                } catch (error) {
                  console.error("Error sending state snapshot", error);
                }
              }

              // Emit run finished event
              subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
              } as RunFinishedEvent);

              // Complete the observable
              subscriber.complete();
            },
          });
        } catch (error) {
          console.error("Stream error:", error);
          subscriber.error(error);
        }
      };

      run();

      return () => {};
    });
  }

  isLocalMastraAgent(agent: LocalMastraAgent | RemoteMastraAgent): agent is LocalMastraAgent {
    return "getMemory" in agent;
  }

  /**
   * Streams in process or remote mastra agent.
   * @param input - The input for the mastra agent.
   * @param options - The options for the mastra agent.
   * @returns The stream of the mastra agent.
   */
  private async streamMastraAgent(
    { threadId, runId, messages, tools, context: inputContext }: RunAgentInput,
    {
      onTextPart,
      onFinishMessagePart,
      onToolCallPart,
      onToolResultPart,
      onError,
      onRunFinished,
    }: MastraAgentStreamOptions,
  ): Promise<void> {
    const clientTools = tools.reduce(
      (acc, tool) => {
        acc[tool.name as string] = {
          id: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        };
        return acc;
      },
      {} as Record<string, any>,
    );
    const resourceId = this.resourceId ?? threadId;

    const convertedMessages = convertAGUIMessagesToMastra(messages);
    this.runtimeContext?.set("ag-ui", { context: inputContext });
    const runtimeContext = this.runtimeContext;

    if (this.isLocalMastraAgent(this.agent)) {
      // Local agent - use the agent's stream method directly
      try {
        const response = await this.agent.stream(convertedMessages, {
          threadId,
          resourceId,
          runId,
          clientTools,
          runtimeContext,
        });

        // For local agents, the response should already be a stream
        // Process it using the agent's built-in streaming mechanism
        if (response && typeof response === "object") {
          for await (const chunk of response.fullStream) {
            handleStreamChunk(chunk, {
              onTextPart,
              onToolCallPart,
              onToolResultPart,
              onFinishMessagePart,
              onError,
            });
          }

          await onRunFinished?.();
        } else {
          throw new Error("Invalid response from local agent");
        }
      } catch (error) {
        onError?.(error as Error);
      }
    } else {
      // Remote agent - use the remote agent's stream method
      try {
        const response = await this.agent.stream({
          threadId,
          resourceId,
          runId,
          messages: convertedMessages,
          clientTools,
        });

        // Remote agents should have a processDataStream method
        if (response && typeof response.processDataStream === "function") {
          await response.processDataStream({
            onChunk: async (chunk) => {
              handleStreamChunk(chunk, {
                onTextPart,
                onToolCallPart,
                onToolResultPart,
                onFinishMessagePart,
                onError,
              });
            },
          });
          await onRunFinished?.();
        } else if (response && typeof (response as { fullStream?: unknown }).fullStream === "object") {
          const fullStream = (response as unknown as { fullStream: AsyncIterable<unknown> }).fullStream;
          for await (const chunk of fullStream) {
            handleStreamChunk(chunk, {
              onTextPart,
              onToolCallPart,
              onToolResultPart,
              onFinishMessagePart,
              onError,
            });
          }
          await onRunFinished?.();
        } else {
          throw new Error("Invalid response from remote agent");
        }
      } catch (error) {
        onError?.(error as Error);
      }
    }
  }

  static async getRemoteAgents(
    options: GetRemoteAgentsOptions,
  ): Promise<Record<string, AbstractAgent>> {
    return getRemoteAgents(options);
  }

  static getLocalAgents(options: GetLocalAgentsOptions): Record<string, AbstractAgent> {
    return getLocalAgents(options);
  }

  static getLocalAgent(options: GetLocalAgentOptions) {
    return getLocalAgent(options);
  }

  static getNetwork(options: GetNetworkOptions) {
    return getNetwork(options);
  }
}

function handleStreamChunk(
  chunk: unknown,
  handlers: {
    onTextPart?: (text: string) => void;
    onToolCallPart?: (streamPart: { toolCallId: string; toolName: string; args: unknown }) => void;
    onToolResultPart?: (streamPart: { toolCallId: string; output: unknown }) => void;
    onFinishMessagePart?: () => void;
    onError?: (error: Error) => void;
  },
) {
  if (!chunk || typeof chunk !== "object" || !("type" in chunk)) {
    return;
  }

  const type = (chunk as { type: string }).type;

  switch (type) {
    case "text-delta": {
      const text = extractTextDelta(chunk);
      if (typeof text === "string" && text.length > 0) {
        handlers.onTextPart?.(text);
      }
      break;
    }

    case "tool-call": {
      const toolCall = extractToolCall(chunk);
      if (toolCall) {
        handlers.onToolCallPart?.(toolCall);
      }
      break;
    }

    case "tool-result": {
      const toolResult = extractToolResult(chunk);
      if (toolResult) {
        handlers.onToolResultPart?.(toolResult);
      }
      break;
    }

    case "tool-error": {
      handlers.onError?.(
        new Error(
          safeStringify((chunk as { error?: unknown }).error ?? "Tool execution failed"),
        ),
      );
      break;
    }

    case "error": {
      handlers.onError?.(extractError(chunk) ?? new Error("Stream error"));
      break;
    }

    case "finish": {
      handlers.onFinishMessagePart?.();
      break;
    }

    default:
      break;
  }
}

function extractTextDelta(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }

  const candidate = chunk as Record<string, unknown>;
  if (typeof candidate.text === "string") {
    return candidate.text;
  }
  if (typeof candidate.delta === "string") {
    return candidate.delta;
  }
  const payload = candidate.payload as Record<string, unknown> | undefined;
  if (payload) {
    if (typeof payload.text === "string") {
      return payload.text;
    }
    if (typeof payload.delta === "string") {
      return payload.delta;
    }
  }
  return undefined;
}

function extractToolCall(chunk: unknown):
  | { toolCallId: string; toolName: string; args: unknown }
  | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }

  const candidate = chunk as Record<string, unknown>;
  const toolCallId = getString(candidate.toolCallId) ?? getString(candidate.tool_call_id);
  const toolName = getString(candidate.toolName) ?? getString(candidate.tool_name);
  const input = candidate.input ?? candidate.args;
  const payload = candidate.payload as Record<string, unknown> | undefined;

  return toolCallId && toolName
    ? {
        toolCallId,
        toolName,
        args: input ?? payload?.input ?? payload?.args,
      }
    : undefined;
}

function extractToolResult(chunk: unknown):
  | { toolCallId: string; output: unknown }
  | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }

  const candidate = chunk as Record<string, unknown>;
  const toolCallId = getString(candidate.toolCallId) ?? getString(candidate.tool_call_id);
  const output = candidate.output ?? candidate.result;
  const payload = candidate.payload as Record<string, unknown> | undefined;

  return toolCallId
    ? {
        toolCallId,
        output: output ?? payload?.output ?? payload?.result,
      }
    : undefined;
}

function extractError(chunk: unknown): Error | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }

  const candidate = chunk as Record<string, unknown>;
  const payload = candidate.payload as Record<string, unknown> | undefined;
  const errorValue = candidate.error ?? payload?.error ?? payload?.message;

  if (!errorValue) {
    return undefined;
  }

  if (errorValue instanceof Error) {
    return errorValue;
  }

  const message = typeof errorValue === "string" ? errorValue : safeStringify(errorValue);
  return new Error(message);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
