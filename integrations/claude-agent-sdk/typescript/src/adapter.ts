/**
 * Claude Agent SDK adapter for AG-UI protocol.
 *
 * This adapter wraps the Claude Agent SDK and produces AG-UI protocol events,
 * enabling Claude-powered agents to work with any AG-UI compatible frontend.
 */

import { Observable, Subscriber } from "rxjs";
import {
  AbstractAgent,
  EventType,
  randomUUID,
} from "@ag-ui/client";
import type {
  BaseEvent,
  RunAgentInput,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
  CustomEvent,
} from "@ag-ui/core";

type ProcessedEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ThinkingTextMessageStartEvent
  | ThinkingTextMessageContentEvent
  | ThinkingTextMessageEndEvent
  | CustomEvent;

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKToolProgressMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Adapter that wraps the Claude Agent SDK for AG-UI servers.
 *
 * Produces AG-UI protocol events via RxJS Observable from Claude SDK responses.
 *
 * @example
 * ```typescript
 * // Using config options
 * const adapter = new ClaudeAgentAdapter({
 *   cwd: "/my/project",
 *   permissionMode: "acceptEdits",
 *   allowedTools: ["Read", "Write", "Bash"],
 * });
 *
 * // Run with AG-UI input
 * const events$ = adapter.run(runAgentInput);
 * events$.subscribe({
 *   next: (event) => console.log(event),
 *   complete: () => console.log("Done"),
 * });
 * ```
 */
import type { ClaudeAgentAdapterConfig } from "./types";
import type {
  BetaToolUseBlock,
  BetaThinkingBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export class ClaudeAgentAdapter extends AbstractAgent {
  private config: ClaudeAgentAdapterConfig;
  private apiKey: string;
  private activeQuery: Query | null = null;

  constructor(config: ClaudeAgentAdapterConfig = {}) {
    super(config);
    this.config = config;
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  }

  /**
   * Clone the adapter for parallel runs or isolated contexts.
   * Creates a fresh instance with copied config but no active query.
   */
  public clone(): ClaudeAgentAdapter {
    const cloned = super.clone() as ClaudeAgentAdapter;
    cloned.config = { ...this.config };
    cloned.apiKey = this.apiKey;
    cloned.activeQuery = null; // Fresh clone has no active query
    return cloned;
  }

  /**
   * Abort the active query (called by AG-UI when stop is requested).
   */
  public abortRun(): void {
    if (this.activeQuery) {
      void this.activeQuery.interrupt();
    }
    super.abortRun();
  }

  /**
   * Process a run and emit AG-UI events.
   *
   * This is the main entry point that consumes RunAgentInput and produces
   * a stream of AG-UI protocol events.
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<ProcessedEvent>((subscriber) => {
      this.runAgentStream(input, subscriber).catch((error) => {
        subscriber.error(error);
      });

      return () => {
        // Cleanup on unsubscribe (interrupt if needed)
        // Query stream will naturally complete or error out
      };
    });
  }

  private async runAgentStream(
    input: RunAgentInput,
    subscriber: Subscriber<ProcessedEvent>
  ): Promise<void> {
    const threadId = input.threadId ?? randomUUID();
    const runId = input.runId ?? randomUUID();

    try {
      // Emit RUN_STARTED
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId,
      });

      // Extract user message
      const userMessage = this.extractUserMessage(input);

      if (!userMessage) {
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
        });
        subscriber.complete();
        return;
      }

      // Run Claude SDK and emit events
      const resultData = await this.streamClaudeSdk(userMessage, threadId, runId, subscriber);

      // Emit RUN_FINISHED with result data
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: resultData,
      });

      subscriber.complete();
    } catch (error) {
      subscriber.next({
        type: EventType.RUN_ERROR,
        threadId,
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      subscriber.complete();
    }
  }

  /**
   * Extract user message text from RunAgentInput.
   */
  private extractUserMessage(input: RunAgentInput): string {
    const messages = input.messages ?? [];

    // Find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const content = msg.content;
        if (typeof content === "string") {
          return content;
        }
        if (Array.isArray(content)) {
          // Content blocks format
          for (const block of content) {
            if ("text" in block && typeof block.text === "string") {
              return block.text;
            }
          }
        }
      }
    }

    return "";
  }

  /**
   * Execute the Claude SDK with the given prompt and emit AG-UI events.
   * Returns result data for RUN_FINISHED event.
   */
  private async streamClaudeSdk(
    prompt: string,
    threadId: string,
    runId: string,
    subscriber: Subscriber<ProcessedEvent>
  ): Promise<Record<string, unknown> | undefined> {
    // Per-run state
    let currentMessageId: string | null = null;
    let inThinkingBlock = false;
    let hasStreamedText = false;
    let resultData: Record<string, unknown> | undefined;

    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY must be set");
    }

    // Set environment variable for SDK
    process.env.ANTHROPIC_API_KEY = this.apiKey;

    // Create query (session continuity handled by SDK if resume is in config)
    const queryStream = query({
      prompt,
      options: {
        ...this.config,
        model: this.config.model ?? "claude-sonnet-4-20250514",
        env: {
          ...process.env,
          ...(this.config.env ?? {}),
          ANTHROPIC_API_KEY: this.apiKey,
        },
      },
    });
    
    // Track active query for interrupt support
    this.activeQuery = queryStream;

    try {
      // Process response stream
      for await (const message of queryStream) {
        // Handle streaming events
        if (message.type === "stream_event") {
          const streamMsg = message as SDKPartialAssistantMessage;
          const event = streamMsg.event as unknown as Record<string, unknown>;
          const eventType = event.type as string;

          if (eventType === "message_start") {
            currentMessageId = randomUUID();
            subscriber.next({
              type: EventType.TEXT_MESSAGE_START,
              threadId,
              runId,
              messageId: currentMessageId,
              role: "assistant",
            });
          } else if (eventType === "content_block_delta") {
            const delta = (event.delta as Record<string, unknown>) ?? {};
            const deltaType = delta.type as string;

            if (deltaType === "text_delta") {
              const text = delta.text as string | undefined;
              if (text && currentMessageId) {
                hasStreamedText = true;
                subscriber.next({
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  threadId,
                  runId,
                  messageId: currentMessageId,
                  delta: text,
                });
              }
            } else if (deltaType === "thinking_delta") {
              const thinking = delta.thinking as string | undefined;
              if (thinking) {
                if (!inThinkingBlock) {
                  inThinkingBlock = true;
                  subscriber.next({
                    type: EventType.THINKING_TEXT_MESSAGE_START,
                  });
                }
                subscriber.next({
                  type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
                  delta: thinking,
                });
              }
            }
          } else if (eventType === "content_block_start") {
            const block = (event.content_block as Record<string, unknown>) ?? {};
            if (block.type === "thinking") {
              inThinkingBlock = true;
              subscriber.next({
                type: EventType.THINKING_TEXT_MESSAGE_START,
              });
            }
            // NOTE: tool_use blocks are NOT handled here to avoid double emissions
            // They are processed from the complete AssistantMessage instead
          } else if (eventType === "content_block_stop") {
            if (inThinkingBlock) {
              inThinkingBlock = false;
              subscriber.next({
                type: EventType.THINKING_TEXT_MESSAGE_END,
              });
            }
          } else if (eventType === "message_stop") {
            if (currentMessageId) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                threadId,
                runId,
                messageId: currentMessageId,
              });
              currentMessageId = null;
            }
          }
        }
        // Handle complete assistant messages
        else if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const content = assistantMsg.message?.content ?? [];
          
          // Process content blocks for tool calls and thinking
          for (const block of content) {
            // Skip text blocks (already streamed)
            if (block.type === "text") {
              continue;
            }
            
            // Handle tool use blocks
            if (block.type === "tool_use") {
              const toolBlock = block as BetaToolUseBlock;
              const toolId = toolBlock.id;
              const toolName = toolBlock.name;
              const toolInput = toolBlock.input as Record<string, unknown> | undefined;
              const parentToolUseId = assistantMsg.parent_tool_use_id;
              
              subscriber.next({
                type: EventType.TOOL_CALL_START,
                threadId,
                runId,
                toolCallId: toolId,
                toolCallName: toolName,
                parentMessageId: parentToolUseId ?? undefined,
              });
              
              if (toolInput && Object.keys(toolInput).length > 0) {
                subscriber.next({
                  type: EventType.TOOL_CALL_ARGS,
                  threadId,
                  runId,
                  toolCallId: toolId,
                  delta: JSON.stringify(toolInput),
                });
              }
            }
            
            // Note: Tool results handled separately (see SDKUserMessage handling below)
            
            // Handle thinking blocks
            if (block.type === "thinking") {
              const thinkingBlock = block as BetaThinkingBlock;
              const thinkingText = thinkingBlock.thinking;
              const signature = thinkingBlock.signature;
              
              if (thinkingText) {
                subscriber.next({
                  type: EventType.THINKING_TEXT_MESSAGE_START,
                });
                subscriber.next({
                  type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
                  delta: thinkingText,
                });
                subscriber.next({
                  type: EventType.THINKING_TEXT_MESSAGE_END,
                });
              }
              
              // Emit signature as custom event if present
              if (signature) {
                subscriber.next({
                  type: EventType.CUSTOM,
                  threadId,
                  runId,
                  name: "thinking_signature",
                  value: { signature },
                });
              }
            }
          }
          
          // Message complete, cleanup any open state
          if (currentMessageId) {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_END,
              threadId,
              runId,
              messageId: currentMessageId,
            });
            currentMessageId = null;
          }
          if (inThinkingBlock) {
            inThinkingBlock = false;
            subscriber.next({
              type: EventType.THINKING_TEXT_MESSAGE_END,
            });
          }
        }
        // Handle user messages (may contain tool results)
        else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;
          
          // Check if this is a synthetic message with tool result
          if (userMsg.isSynthetic && userMsg.tool_use_result !== undefined) {
            // This is a tool result - extract the tool_use_id from message content
            const msgContent = userMsg.message as { content?: unknown[] };
            const toolResultBlock = msgContent.content?.find(
              (block: any) => block.type === "tool_result"
            ) as { tool_use_id?: string; content?: unknown; is_error?: boolean } | undefined;
            
            if (toolResultBlock?.tool_use_id) {
              let resultStr: string;
              try {
                resultStr = JSON.stringify(toolResultBlock.content);
              } catch {
                resultStr = String(toolResultBlock.content ?? "");
              }
              
              // Emit TOOL_CALL_END
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                threadId,
                runId,
                toolCallId: toolResultBlock.tool_use_id,
              });
              
              // Emit TOOL_CALL_RESULT
              subscriber.next({
                type: EventType.TOOL_CALL_RESULT,
                threadId,
                runId,
                messageId: `${toolResultBlock.tool_use_id}-result`,
                toolCallId: toolResultBlock.tool_use_id,
                content: resultStr,
                role: "tool",
              });
            }
          }
        }
        // Handle tool progress messages
        else if (message.type === "tool_progress") {
          // Tool progress updates (could emit custom events if needed)
        }
        // Handle system messages
        else if (message.type === "system") {
          const sysMsg = message as SDKSystemMessage;
          // Emit system message as JSON
          const msgText = JSON.stringify(sysMsg, null, 2);
          this.emitSystemMessage(subscriber, threadId, runId, msgText);
        }
        // Handle result messages
        else if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;
          
          resultData = {
            isError: (resultMsg as {is_error?: boolean}).is_error ?? false,
            result: (resultMsg as {result?: string}).result ?? "",
            durationMs: (resultMsg as {duration_ms?: number}).duration_ms,
            durationApiMs: (resultMsg as {duration_api_ms?: number}).duration_api_ms,
            numTurns: (resultMsg as {num_turns?: number}).num_turns,
            totalCostUsd: (resultMsg as {total_cost_usd?: number}).total_cost_usd,
            usage: (resultMsg as {usage?: Record<string, unknown>}).usage ?? {},
          };

          // Only display result text if we haven't streamed text
          const result = (resultMsg as {result?: string}).result;
          if (!hasStreamedText && result) {
            const resultMsgId = randomUUID();
            subscriber.next({
              type: EventType.TEXT_MESSAGE_START,
              threadId,
              runId,
              messageId: resultMsgId,
              role: "assistant",
            });
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              threadId,
              runId,
              messageId: resultMsgId,
              delta: result,
            });
            subscriber.next({
              type: EventType.TEXT_MESSAGE_END,
              threadId,
              runId,
              messageId: resultMsgId,
            });
          }
        }
      }

      return resultData;
    } finally {
      // Cleanup handled by Observable unsubscribe
    }
  }

  /**
   * Emit a system message as AG-UI text message events.
   */
  private emitSystemMessage(
    subscriber: Subscriber<ProcessedEvent>,
    threadId: string,
    runId: string,
    message: string
  ): void {
    const msgId = randomUUID();
    subscriber.next({
      type: EventType.TEXT_MESSAGE_START,
      threadId,
      runId,
      messageId: msgId,
      role: "system",
    });
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      threadId,
      runId,
      messageId: msgId,
      delta: message,
    });
    subscriber.next({
      type: EventType.TEXT_MESSAGE_END,
      threadId,
      runId,
      messageId: msgId,
    });
  }

}
