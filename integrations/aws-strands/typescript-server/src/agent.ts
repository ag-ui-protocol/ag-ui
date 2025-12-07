import {
  Agent as StrandsAgentCore,
  type ContentBlockData,
  type SystemPrompt,
} from "@strands-agents/sdk";
import { randomUUID } from "crypto";
import {
  StrandsAgentConfig,
  ToolCallContext,
  ToolResultContext,
  maybeAwait,
  normalizePredictState,
} from "./config";
import {
  AguiEvent,
  CustomEvent,
  EventType,
  MessageContent,
  RunAgentInput,
  StateSnapshotEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "./types";
import { StrandsAgentLike, extractTools, getToolName } from "./agent-tools";
import {
  StrandsStreamEvent,
  extractTextChunk,
  getToolResultText,
  isAguiEvent,
  isAsyncGenerator,
  isToolResultItem,
  isUserMessage,
  parseJsonLenient,
  toStreamEvent,
} from "./agent-streaming";
import {
  applyBuilderTextToBlocks,
  convertMessageContent,
} from "./agent-content";

type StrandsAgentInstance = InstanceType<typeof StrandsAgentCore> &
  StrandsAgentLike;

interface ToolCallMeta {
  name?: string;
  args?: string;
  input?: unknown;
  emitted?: boolean;
  strandsToolId?: string;
}

export class StrandsAgent {
  readonly name: string;
  readonly description: string;
  readonly config: StrandsAgentConfig;

  private readonly baseModel: unknown;
  private readonly systemPrompt?: string | SystemPrompt;
  private readonly tools: unknown[];
  private readonly agentOptions: Record<string, unknown>;
  private readonly agentsByThread = new Map<string, StrandsAgentInstance>();

  constructor(
    agent: StrandsAgentInstance,
    name: string,
    description = "",
    config?: StrandsAgentConfig
  ) {
    const source: StrandsAgentLike = agent;
    this.baseModel = source.model;
    this.systemPrompt = (source.systemPrompt ?? source.system_prompt ?? "") as
      | string
      | SystemPrompt
      | undefined;
    this.tools = extractTools(source);
    this.agentOptions = {
      recordDirectToolCall:
        typeof source.recordDirectToolCall === "boolean"
          ? source.recordDirectToolCall
          : true,
    };

    this.name = name;
    this.description = description;
    this.config = config ?? { toolBehaviors: {} };
  }

  private createAgent(): StrandsAgentInstance {
    const options: Record<string, unknown> = {
      model: this.baseModel,
      systemPrompt: this.systemPrompt,
      tools: this.tools,
    };

    if ("recordDirectToolCall" in this.agentOptions) {
      options.recordDirectToolCall = this.agentOptions.recordDirectToolCall;
    }

    const created = new StrandsAgentCore(
      options as ConstructorParameters<typeof StrandsAgentCore>[0]
    );
    return created as StrandsAgentInstance;
  }

  private ensureAgent(threadId: string): StrandsAgentInstance {
    if (!this.agentsByThread.has(threadId)) {
      this.agentsByThread.set(threadId, this.createAgent());
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.agentsByThread.get(threadId)!;
  }

  private createStream(
    agent: StrandsAgentInstance,
    userMessage: string | ContentBlockData[]
  ): AsyncIterable<unknown> {
    if (typeof agent.streamAsync === "function") {
      return agent.streamAsync(userMessage);
    }
    if (typeof agent.stream === "function") {
      return agent.stream(userMessage);
    }
    throw new Error("Strands Agent does not support streaming");
  }

  async *run(inputData: RunAgentInput): AsyncGenerator<AguiEvent> {
    const threadId = inputData.thread_id ?? inputData.threadId ?? "default";
    const runId = inputData.run_id ?? inputData.runId ?? randomUUID();

    if (inputData.thread_id == null) {
      inputData.thread_id = threadId;
    }
    if (inputData.threadId == null) {
      inputData.threadId = threadId;
    }
    if (inputData.run_id == null) {
      inputData.run_id = runId;
    }
    if (inputData.runId == null) {
      inputData.runId = runId;
    }

    const strandsAgent = this.ensureAgent(threadId);

    yield {
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    };

    try {
      if (inputData.state) {
        const { messages, ...stateSnapshot } = inputData.state;
        yield {
          type: EventType.STATE_SNAPSHOT,
          snapshot: stateSnapshot as Record<string, unknown>,
        } satisfies StateSnapshotEvent;
      }

      const frontendToolNames = new Set<string>();
      if (inputData.tools) {
        for (const tool of inputData.tools) {
          const toolName = getToolName(tool);
          if (toolName) frontendToolNames.add(toolName);
        }
      }

      let hasPendingToolResult = false;
      if (inputData.messages?.length) {
        const lastMessage = inputData.messages[inputData.messages.length - 1];
        if (lastMessage.role === "tool") {
          hasPendingToolResult = true;
        }
      }

      let messageContent: MessageContent | undefined;
      if (inputData.messages?.length) {
        for (let i = inputData.messages.length - 1; i >= 0; i -= 1) {
          const msg = inputData.messages[i];
          if ((msg.role === "user" || msg.role === "tool") && msg.content) {
            messageContent = msg.content;
            break;
          }
        }
      }

      const convertedContent = convertMessageContent(messageContent);
      let userMessage = convertedContent.textSummary || "Hello";
      let streamPayload: string | ContentBlockData[] =
        convertedContent.hasBinaryContent
          ? convertedContent.blocks
          : userMessage;

      if (this.config.stateContextBuilder) {
        try {
          const rewritten = await maybeAwait(
            this.config.stateContextBuilder(inputData, userMessage)
          );
          userMessage = rewritten;
          if (Array.isArray(streamPayload)) {
            streamPayload = applyBuilderTextToBlocks(
              streamPayload,
              convertedContent.textBlockIndexes,
              rewritten
            );
          } else {
            streamPayload = rewritten;
          }
        } catch (error) {
          // Continue with the original message if the builder fails
          // eslint-disable-next-line no-console
          console.warn("State context builder failed", error);
        }
      }

      const messageId = randomUUID();
      let messageStarted = false;
      let stopTextStreaming = false;
      let haltEventStream = false;

      const toolCallsSeen = new Map<string, ToolCallMeta>();
      const behaviorMap = this.config.toolBehaviors ?? {};

      const stream = this.createStream(strandsAgent, streamPayload);

      try {
        // eslint-disable-next-line no-restricted-syntax
        for await (const rawEvent of stream) {
          const event = toStreamEvent(rawEvent);
          if (haltEventStream) {
            continue;
          }

          if (
            event?.init_event_loop ||
            event?.start_event_loop ||
            event?.initEventLoop ||
            event?.startEventLoop
          ) {
            continue;
          }
          if (event?.complete || event?.force_stop || event?.forceStop) {
            break;
          }

          const textChunk = extractTextChunk(event);
          if (textChunk !== null && textChunk !== "") {
            /* istanbul ignore next -- stopTextStreaming is always paired with haltEventStream */
            if (stopTextStreaming) {
              continue;
            }

            if (!messageStarted) {
              yield {
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                message_id: messageId,
                role: "assistant",
              } satisfies TextMessageStartEvent;
              messageStarted = true;
            }

            yield {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              message_id: messageId,
              delta: textChunk,
            } satisfies TextMessageContentEvent;
            continue;
          }

          const strandsMessage = event?.message;
          if (isUserMessage(strandsMessage)) {
            const messageContent = Array.isArray(strandsMessage.content)
              ? strandsMessage.content
              : [];

            for (const item of messageContent) {
              if (!isToolResultItem(item)) {
                continue;
              }

              const toolResult = item.toolResult;
              const resultToolId =
                toolResult.toolUseId || toolResult.tool_use_id;
              const textContent = getToolResultText(toolResult.content);

              if (!resultToolId || textContent === null) {
                continue;
              }

              const resultData = parseJsonLenient(textContent);
              const toolCallId = String(resultToolId);
              const callInfo = toolCallsSeen.get(toolCallId);
              const toolName = callInfo?.name;
              const toolInput = callInfo?.input;
              const argsStr = callInfo?.args;
              const behavior = toolName ? behaviorMap[toolName] : undefined;

              yield {
                type: EventType.TOOL_CALL_RESULT,
                toolCallId,
                tool_call_id: toolCallId,
                messageId,
                message_id: messageId,
                content: JSON.stringify(resultData),
              } satisfies ToolCallResultEvent;

              const resultContext: ToolResultContext = {
                inputData,
                toolName: toolName ?? "",
                toolUseId: toolCallId,
                toolInput,
                argsStr: argsStr ?? "{}",
                resultData,
                messageId,
              };

              if (behavior?.stateFromResult) {
                try {
                  const snapshot = await maybeAwait(
                    behavior.stateFromResult(resultContext)
                  );
                  if (snapshot) {
                    yield {
                      type: EventType.STATE_SNAPSHOT,
                      snapshot: snapshot as Record<string, unknown>,
                    } satisfies StateSnapshotEvent;
                  }
                } catch (error) {
                  console.warn(
                    `stateFromResult failed for ${toolName ?? "tool"}`,
                    error
                  );
                }
              }

              if (behavior?.customResultHandler) {
                try {
                  for await (const customEvent of behavior.customResultHandler(
                    resultContext
                  )) {
                    if (isAguiEvent(customEvent)) {
                      yield customEvent;
                    }
                  }
                } catch (error) {
                  console.warn(
                    `customResultHandler failed for ${toolName ?? "tool"}`,
                    error
                  );
                }
              }

              if (behavior?.stopStreamingAfterResult) {
                stopTextStreaming = true;
                if (messageStarted) {
                  yield {
                    type: EventType.TEXT_MESSAGE_END,
                    messageId,
                    message_id: messageId,
                  } satisfies TextMessageEndEvent;
                  messageStarted = false;
                }
                haltEventStream = true;
              }
            }
            continue;
          }

          const currentToolUse =
            event?.current_tool_use ?? event?.currentToolUse;
          if (currentToolUse) {
            const toolName =
              typeof currentToolUse.name === "string"
                ? currentToolUse.name
                : undefined;
            const strandsToolId =
              currentToolUse.toolUseId ?? currentToolUse.tool_use_id;

            let toolUseId: string | undefined;
            for (const [id, data] of toolCallsSeen.entries()) {
              if (data.strandsToolId && data.strandsToolId === strandsToolId) {
                toolUseId = id;
                break;
              }
            }

            const isFrontendTool = toolName && frontendToolNames.has(toolName);

            if (!toolUseId) {
              toolUseId = isFrontendTool
                ? randomUUID()
                : strandsToolId || randomUUID();
            }

            const rawInput = currentToolUse.input ?? "";
            let toolInput: unknown = {};
            if (typeof rawInput === "string" && rawInput) {
              try {
                toolInput = JSON.parse(rawInput);
              } catch {
                toolInput = rawInput;
              }
            } else if (typeof rawInput === "object" && rawInput !== null) {
              toolInput = rawInput;
            }

            const argsStr =
              typeof toolInput === "object"
                ? JSON.stringify(toolInput)
                : String(toolInput);

            const isNewToolCall = toolName && !toolCallsSeen.has(toolUseId);
            if (isNewToolCall) {
              toolCallsSeen.set(toolUseId, {
                name: toolName,
                args: argsStr,
                input: toolInput,
                emitted: false,
                strandsToolId,
              });
            } else if (toolCallsSeen.has(toolUseId)) {
              const entry = toolCallsSeen.get(toolUseId)!;
              entry.input = toolInput;
              entry.args = argsStr;
            }
            continue;
          }

          const innerEvent = event?.event;
          if (innerEvent && typeof innerEvent === "object") {
            if ("contentBlockStop" in innerEvent) {
              let toolName: string | undefined;
              let toolInput: unknown;
              let argsStr: string | undefined;
              let toolUseId: string | undefined;

              for (const [id, data] of toolCallsSeen.entries()) {
                if (!data.emitted) {
                  toolName = data.name;
                  toolInput = data.input;
                  argsStr = data.args;
                  toolUseId = id;
                  data.emitted = true;
                  break;
                }
              }

              if (toolName && toolUseId) {
                const isFrontendTool = frontendToolNames.has(toolName);
                const behavior = behaviorMap[toolName];
                const normalizedArgsStr = argsStr ?? "{}";
                const callContext: ToolCallContext = {
                  inputData,
                  toolName,
                  toolUseId,
                  toolInput,
                  argsStr: normalizedArgsStr,
                };

                if (behavior?.stateFromArgs) {
                  try {
                    const snapshot = await maybeAwait(
                      behavior.stateFromArgs(callContext)
                    );
                    if (snapshot) {
                      yield {
                        type: EventType.STATE_SNAPSHOT,
                        snapshot: snapshot as Record<string, unknown>,
                      } satisfies StateSnapshotEvent;
                    }
                  } catch (error) {
                    // eslint-disable-next-line no-console
                    console.warn(`stateFromArgs failed for ${toolName}`, error);
                  }
                }

                if (behavior) {
                  const predictPayload = normalizePredictState(
                    behavior.predictState
                  ).map((mapping) => mapping.toPayload());
                  if (predictPayload.length) {
                    yield {
                      type: EventType.CUSTOM,
                      name: "PredictState",
                      value: predictPayload,
                    } satisfies CustomEvent;
                  }
                }

                if (!hasPendingToolResult) {
                  yield {
                    type: EventType.TOOL_CALL_START,
                    toolCallId: toolUseId,
                    tool_call_id: toolUseId,
                    toolCallName: toolName,
                    tool_call_name: toolName,
                    parentMessageId: messageId,
                    parent_message_id: messageId,
                  } satisfies ToolCallStartEvent;

                  if (behavior?.argsStreamer) {
                    try {
                      for await (const chunk of behavior.argsStreamer(
                        callContext
                      )) {
                        if (chunk === null || chunk === undefined) continue;
                        yield {
                          type: EventType.TOOL_CALL_ARGS,
                          toolCallId: toolUseId,
                          tool_call_id: toolUseId,
                          delta: String(chunk),
                        } satisfies ToolCallArgsEvent;
                      }
                    } catch (error) {
                      // eslint-disable-next-line no-console
                      console.warn(
                        `argsStreamer failed for ${toolName}, sending full args`,
                        error
                      );
                      yield {
                        type: EventType.TOOL_CALL_ARGS,
                        toolCallId: toolUseId,
                        tool_call_id: toolUseId,
                        delta: normalizedArgsStr,
                      } satisfies ToolCallArgsEvent;
                    }
                  } else {
                    yield {
                      type: EventType.TOOL_CALL_ARGS,
                      toolCallId: toolUseId,
                      tool_call_id: toolUseId,
                      delta: normalizedArgsStr,
                    } satisfies ToolCallArgsEvent;
                  }

                  yield {
                    type: EventType.TOOL_CALL_END,
                    toolCallId: toolUseId,
                    tool_call_id: toolUseId,
                  } satisfies ToolCallEndEvent;

                  if (isFrontendTool && !behavior?.continueAfterFrontendCall) {
                    haltEventStream = true;
                  }
                }
              }
            }
          }
        }
      } finally {
        if (isAsyncGenerator(stream) && typeof stream.return === "function") {
          try {
            await stream.return(undefined as unknown);
          } catch {
            // ignore
          }
        }
      }

      if (messageStarted) {
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          message_id: messageId,
        } satisfies TextMessageEndEvent;
      }

      yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
      };
    } catch (error: unknown) {
      yield {
        type: EventType.RUN_ERROR,
        message:
          typeof error === "object" && error && "message" in error
            ? String((error as { message?: unknown }).message)
            : "Unknown error",
        code: "STRANDS_ERROR",
      };
    }
  }
}
