import type {
  AgentConfig,
  BaseEvent,
  CustomEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
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
import type { StorageThreadType } from "@mastra/core/memory";
import type { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { randomUUID } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { MastraClient } from "@mastra/client-js";
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

type RemoteMastraAgent = ReturnType<MastraClient["getAgent"]>;

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId: string;
  requestContext?: RequestContext;
}

interface MastraAgentStreamOptions {
  onTextPart?: (text: string) => void;
  onReasoningPart?: (text: string) => void;
  onFinishMessagePart?: () => void;
  onToolCallPart?: (streamPart: {
    toolCallId: string;
    toolName: string;
    args: any;
  }) => void;
  onToolResultPart?: (streamPart: { toolCallId: string; result: any }) => void;
  onError: (error: Error) => void;
  onRunFinished?: () => Promise<void>;
  onToolSuspended: (payload: {
    toolCallId: string;
    toolName: string;
    suspendPayload: any;
    args: Record<string, any>;
    resumeSchema: string;
  }) => void;
}

export class MastraAgent extends AbstractAgent {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId: string;
  requestContext?: RequestContext;

  constructor(private config: MastraAgentConfig) {
    const { agent, resourceId, requestContext, ...rest } = config;
    super(rest);
    this.agent = agent;
    this.resourceId = resourceId;
    this.requestContext = requestContext ?? new RequestContext();
  }

  public clone() {
    return new MastraAgent(this.config);
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

        // CopilotKit passes resume data via forwardedProps.command (convention
        // shared with LangGraph's interrupt bridge). forwardedProps is untyped
        // (any) — the caller is responsible for shape validation.
        const forwardedCommand = input.forwardedProps?.command;

        // resume: false means the user explicitly declined the tool call.
        // Close the run cleanly without calling resumeStream.
        if (forwardedCommand?.resume === false && forwardedCommand?.interruptEvent) {
          await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as RunFinishedEvent);
          subscriber.complete();
          return;
        }

        if (forwardedCommand?.resume != null && forwardedCommand?.interruptEvent) {
          // Safely parse interruptEvent — client-supplied data
          let interruptEvent: any;
          try {
            interruptEvent =
              typeof forwardedCommand.interruptEvent === "string"
                ? JSON.parse(forwardedCommand.interruptEvent)
                : forwardedCommand.interruptEvent;
          } catch (err) {
            subscriber.error(
              new Error("Invalid interruptEvent: malformed JSON", {
                cause: err,
              }),
            );
            return;
          }

          // Validate required fields for resume
          if (!interruptEvent?.toolCallId || !interruptEvent?.runId) {
            subscriber.error(
              new Error(
                "Invalid interruptEvent: missing toolCallId or runId",
              ),
            );
            return;
          }

          // Remote agent resume is not yet supported — error, don't fake success
          if (!this.isLocalMastraAgent(this.agent)) {
            subscriber.error(
              new Error(
                "Resume from interrupt is not yet supported for remote Mastra agents",
              ),
            );
            return;
          }

          try {
            const response = await this.agent.resumeStream(
              forwardedCommand.resume,
              {
                toolCallId: interruptEvent.toolCallId,
                runId: interruptEvent.runId,
                memory: {
                  thread: input.threadId,
                  resource: this.resourceId ?? input.threadId,
                },
                requestContext: this.requestContext,
              },
            );

            // Null/invalid response from resumeStream is an error
            if (!response || typeof response !== "object" || !response.fullStream) {
              subscriber.error(
                new Error("resumeStream returned no valid response (missing fullStream)"),
              );
              return;
            }

            const callbacks = this.makeStreamCallbacks(
              subscriber,
              () => messageId,
              (id) => { messageId = id; },
              input.runId,
            );
            const hadError = await this.processFullStream(response.fullStream, {
              ...callbacks,
              onError: (error) => {
                subscriber.error(error);
              },
            });

            if (!hadError) {
              await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
              subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
              } as RunFinishedEvent);
              subscriber.complete();
            }
          } catch (error) {
            subscriber.error(error);
          }
          return;
        }

        // Sync AG-UI input state into Mastra's working memory before streaming
        if (this.isLocalMastraAgent(this.agent)) {
          try {
            const memory = await this.agent.getMemory({
              requestContext: this.requestContext,
            });

            if (
              memory &&
              input.state &&
              Object.keys(input.state).length > 0
            ) {
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

              let existingMemory: Record<string, any> = {};
              try {
                existingMemory = JSON.parse(
                  (thread.metadata?.workingMemory as string) ?? "{}",
                );
              } catch {
                // Working memory metadata is not valid JSON - start fresh
              }
              const { messages, ...rest } = input.state;
              const workingMemory = JSON.stringify({
                ...existingMemory,
                ...rest,
              });

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
          } catch (error) {
            subscriber.error(error);
            return;
          }
        }

        try {
          const streamCallbacks = this.makeStreamCallbacks(
            subscriber,
            () => messageId,
            (id) => { messageId = id; },
            input.runId,
          );

          await this.streamMastraAgent(input, {
            ...streamCallbacks,
            onError: (error) => {
              subscriber.error(error);
            },
            onRunFinished: async () => {
              await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
              subscriber.next({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
              } as RunFinishedEvent);
              subscriber.complete();
            },
          });
        } catch (error) {
          subscriber.error(error);
        }
      };

      run().catch((err) => {
        if (subscriber.closed) return;
        subscriber.error(err);
      });

      return () => {};
    });
  }

  isLocalMastraAgent(
    agent: LocalMastraAgent | RemoteMastraAgent,
  ): agent is LocalMastraAgent {
    return "getMemory" in agent;
  }

  /**
   * Fetches working memory from a local agent and emits a STATE_SNAPSHOT event
   * if valid working memory is available.
   *
   * Best-effort: logs a warning and returns gracefully on failure so callers
   * can proceed with RUN_FINISHED even when the snapshot could not be delivered.
   */
  private async emitWorkingMemorySnapshot(
    subscriber: { next: (event: BaseEvent) => void },
    threadId: string,
  ): Promise<boolean> {
    if (!this.isLocalMastraAgent(this.agent)) return true;
    try {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (memory) {
        const workingMemory = await memory.getWorkingMemory({
          resourceId: this.resourceId,
          threadId,
          memoryConfig: {
            workingMemory: {
              enabled: true,
            },
          },
        });

        if (typeof workingMemory === "string") {
          let snapshot: Record<string, any> | null = null;
          try {
            snapshot = JSON.parse(workingMemory);
          } catch {
            // Working memory is not valid JSON (e.g. markdown template)
            // Wrap it so the client still receives the state
            snapshot = { workingMemory };
          }

          // Skip snapshots containing a JSON Schema definition ($schema) —
          // these are Mastra's working-memory templates, not actual state.
          if (snapshot && !("$schema" in snapshot)) {
            subscriber.next({
              type: EventType.STATE_SNAPSHOT,
              snapshot,
            } as StateSnapshotEvent);
          }
        }
      }
      return true;
    } catch (error) {
      console.warn(
        `[MastraAgent] Failed to emit working memory snapshot for thread ${threadId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Creates the callback set used by processFullStream to emit AG-UI events.
   * messageId is accessed/mutated via getter/setter closures so that when
   * onFinishMessagePart replaces the ID with a new UUID, subsequent callbacks
   * in the same run() invocation see the updated value.
   */
  private makeStreamCallbacks(
    subscriber: { next: (event: BaseEvent) => void },
    getMessageId: () => string,
    setMessageId: (id: string) => void,
    runId: string,
  ): Omit<MastraAgentStreamOptions, "onError" | "onRunFinished"> {
    let reasoningMessageId: string | null = null;
    let isReasoning = false;

    const closeReasoning = () => {
      if (isReasoning && reasoningMessageId) {
        subscriber.next({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId,
        } as ReasoningMessageEndEvent);
        subscriber.next({
          type: EventType.REASONING_END,
          messageId: reasoningMessageId,
        } as ReasoningEndEvent);
        isReasoning = false;
        reasoningMessageId = null;
      }
    };

    return {
      onReasoningPart: (text) => {
        if (!isReasoning) {
          reasoningMessageId = randomUUID();
          isReasoning = true;
          subscriber.next({
            type: EventType.REASONING_START,
            messageId: reasoningMessageId,
          } as ReasoningStartEvent);
          subscriber.next({
            type: EventType.REASONING_MESSAGE_START,
            messageId: reasoningMessageId,
            role: "reasoning",
          } as ReasoningMessageStartEvent);
        }
        subscriber.next({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningMessageId!,
          delta: text,
        } as ReasoningMessageContentEvent);
      },
      onTextPart: (text) => {
        closeReasoning();
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: "assistant",
          messageId: getMessageId(),
          delta: text,
        } as TextMessageChunkEvent);
      },
      onToolCallPart: (streamPart) => {
        closeReasoning();
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          parentMessageId: getMessageId(),
          toolCallId: streamPart.toolCallId,
          toolCallName: streamPart.toolName,
        } as ToolCallStartEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: streamPart.toolCallId,
          delta: JSON.stringify(streamPart.args),
        } as ToolCallArgsEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: streamPart.toolCallId,
        } as ToolCallEndEvent);
      },
      onToolResultPart: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: streamPart.toolCallId,
          content: JSON.stringify(streamPart.result),
          messageId: randomUUID(),
          role: "tool",
        } as ToolCallResultEvent);
      },
      onToolSuspended: (payload) => {
        subscriber.next({
          type: EventType.CUSTOM,
          name: "on_interrupt",
          value: JSON.stringify({
            type: "mastra_suspend",
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            suspendPayload: payload.suspendPayload,
            args: payload.args,
            resumeSchema: payload.resumeSchema,
            runId,
          }),
        } as CustomEvent);
      },
      onFinishMessagePart: () => {
        closeReasoning();
        setMessageId(randomUUID());
      },
    };
  }

  /**
   * Creates a stateful chunk processor that maps Mastra stream chunks to
   * AG-UI events via callbacks. Buffers tool-call chunks: if followed by
   * tool-call-suspended, the TOOL_CALL_* events are suppressed (the tool
   * hasn't executed yet — emitting them confuses CopilotKit's orchestration
   * which expects a TOOL_CALL_RESULT to follow).
   *
   * Used by both the local agent path (async iterable) and the remote agent
   * path (processDataStream callback) — single source of truth for chunk
   * handling and buffering logic.
   *
   * @returns An object with two methods:
   *   - `handleChunk`: processes a single chunk; returns `true` if processing should stop (error or malformed chunk).
   *   - `flush`: emits any buffered tool-call (call at end of stream).
   */
  private createChunkProcessor(callbacks: MastraAgentStreamOptions) {
    let pendingToolCall: {
      toolCallId: string;
      toolName: string;
      args: any;
    } | null = null;

    const flush = () => {
      if (pendingToolCall) {
        callbacks.onToolCallPart?.(pendingToolCall);
        pendingToolCall = null;
      }
    };

    const handleChunk = (chunk: any): boolean => {
      if (!chunk || !chunk.payload) {
        callbacks.onError(
          new Error(
            `Malformed stream chunk: type=${chunk?.type ?? "undefined"}, missing payload`,
          ),
        );
        return true;
      }
      switch (chunk.type) {
        case "reasoning": {
          callbacks.onReasoningPart?.(chunk.payload.text);
          break;
        }
        case "text-delta": {
          flush();
          callbacks.onTextPart?.(chunk.payload.text);
          break;
        }
        case "tool-call": {
          flush();
          pendingToolCall = {
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            args: chunk.payload.args,
          };
          break;
        }
        case "tool-result": {
          flush();
          callbacks.onToolResultPart?.({
            toolCallId: chunk.payload.toolCallId,
            result: chunk.payload.result,
          });
          break;
        }
        case "error": {
          const error = new Error(chunk.payload.error as string);
          callbacks.onError(error);
          return true;
        }
        case "tool-call-suspended": {
          // Always discard the pending tool-call: if it matches, the tool
          // was suspended before execution; if it doesn't match, the pending
          // call is orphaned (never executed) so emitting TOOL_CALL_START/
          // ARGS/END without a TOOL_CALL_RESULT would violate the protocol.
          pendingToolCall = null;
          if (!chunk.payload.toolCallId || !chunk.payload.toolName) {
            callbacks.onError(
              new Error(
                `Malformed tool-call-suspended: missing toolCallId or toolName in payload`,
              ),
            );
            return true;
          }
          callbacks.onToolSuspended({
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            suspendPayload: chunk.payload.suspendPayload,
            args: chunk.payload.args,
            resumeSchema: chunk.payload.resumeSchema,
          });
          break;
        }
        // Both "finish" and "step-finish" flush any pending tool call and rotate
        // the messageId so the next step's text gets a fresh ID. When a stream
        // ends with step-finish followed by finish, onFinishMessagePart fires
        // twice — the second rotation produces an unused messageId, which is harmless.
        case "finish":
        case "step-finish": {
          flush();
          callbacks.onFinishMessagePart?.();
          break;
        }
        // Known Mastra lifecycle events with no AG-UI mapping — skip silently
        case "start":
        case "step-start":
          break;
        default: {
          console.warn(
            `[MastraAgent] Unrecognized stream chunk type: ${chunk.type}`,
          );
          break;
        }
      }
      return false;
    };

    return { handleChunk, flush };
  }

  /**
   * Processes a Mastra fullStream (async iterable) using createChunkProcessor.
   * @returns true if processing stopped early (error chunk or malformed chunk).
   */
  private async processFullStream(
    stream: AsyncIterable<any>,
    callbacks: MastraAgentStreamOptions,
  ): Promise<boolean> {
    const { handleChunk, flush } = this.createChunkProcessor(callbacks);
    for await (const chunk of stream) {
      if (handleChunk(chunk)) return true;
    }
    flush();
    return false;
  }

  /**
   * Streams a local or remote Mastra agent, emitting AG-UI events via callbacks.
   * For local agents, iterates fullStream with processFullStream.
   * For remote agents, uses processDataStream with createChunkProcessor.
   * Calls onRunFinished on success. For errors, onError is called either from
   * within stream processing (error chunks) or from the catch block (thrown exceptions).
   */
  private async streamMastraAgent(
    { threadId, runId, messages, tools, context: inputContext }: RunAgentInput,
    {
      onTextPart,
      onReasoningPart,
      onFinishMessagePart,
      onToolCallPart,
      onToolResultPart,
      onToolSuspended,
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
    this.requestContext?.set("ag-ui", { context: inputContext });
    const requestContext = this.requestContext;

    if (this.isLocalMastraAgent(this.agent)) {
      try {
        const response = await this.agent.stream(convertedMessages, {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
        });

        if (response && typeof response === "object") {
          const hadError = await this.processFullStream(response.fullStream, {
            onTextPart,
            onReasoningPart,
            onFinishMessagePart,
            onToolCallPart,
            onToolResultPart,
            onToolSuspended,
            onError,
          });

          if (!hadError) await onRunFinished?.();
        } else {
          throw new Error("Invalid response from local agent");
        }
      } catch (error) {
        onError(error as Error);
      }
    } else {
      let stopped = false;
      try {
        const response = await this.agent.stream(convertedMessages, {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
        });

        // Remote agents use processDataStream (callback-based) — share
        // chunk handling logic via createChunkProcessor.
        if (response && typeof response.processDataStream === "function") {
          const { handleChunk, flush } = this.createChunkProcessor({
            onTextPart,
            onReasoningPart,
            onFinishMessagePart,
            onToolCallPart,
            onToolResultPart,
            onToolSuspended,
            onError,
          });

          await response.processDataStream({
            onChunk: async (chunk: any) => {
              if (stopped) return;
              if (handleChunk(chunk)) stopped = true;
            },
          });
          if (!stopped) flush();
          if (!stopped) await onRunFinished?.();
        } else {
          throw new Error("Invalid response from remote agent");
        }
      } catch (error) {
        if (!stopped) onError(error as Error);
      }
    }
  }

  static async getRemoteAgents(
    options: GetRemoteAgentsOptions,
  ): Promise<Record<string, AbstractAgent>> {
    return getRemoteAgents(options);
  }

  static getLocalAgents(
    options: GetLocalAgentsOptions,
  ): Record<string, AbstractAgent> {
    return getLocalAgents(options);
  }

  static getLocalAgent(options: GetLocalAgentOptions) {
    return getLocalAgent(options);
  }

  static getNetwork(options: GetNetworkOptions) {
    return getNetwork(options);
  }
}
