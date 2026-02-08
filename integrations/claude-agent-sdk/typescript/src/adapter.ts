/**
 * Claude Agent SDK adapter for AG-UI protocol.
 *
 * This adapter wraps the Claude Agent SDK and produces AG-UI protocol events,
 * enabling Claude-powered agents to work with any AG-UI compatible frontend.
 *
 * Features:
 * - Session management: Automatic session tracking per thread with resumption support
 * - Dynamic frontend tools: Client-provided tools automatically added as MCP server
 * - Frontend tool halting: Streams pause after frontend tool calls for client-side execution
 * - Streaming tool arguments: Real-time TOOL_CALL_ARGS emission as JSON arguments stream in
 * - Bidirectional state sync: Shared state management via ag_ui_update_state tool
 * - Context injection: Context and state injected into prompts for agent awareness
 * - Forwarded props: Per-run option overrides with security whitelist
 */

import { Observable, Subscriber } from "rxjs";
import { AbstractAgent, EventType, randomUUID } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BetaToolUseBlock,
  BetaThinkingBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ClaudeAgentAdapterConfig, ProcessedEvent } from "./types";
import {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  STATE_MANAGEMENT_TOOL_FULL_NAME,
  AG_UI_MCP_SERVER_NAME,
} from "./config";
import {
  processMessages,
  injectStateAndContextIntoPrompt,
  extractToolNames,
  stripMcpPrefix,
  convertAguiToolToClaudeSdk,
  createStateManagementTool,
  applyForwardedProps,
  hasState,
} from "./utils";
import {
  handleToolUseBlock,
  emitSystemMessageEvents,
} from "./handlers";

/**
 * Adapter that wraps the Claude Agent SDK for AG-UI servers.
 *
 * Produces AG-UI protocol events via RxJS Observable from Claude SDK responses.
 *
 * RunAgentInput Field Handling:
 *   - threadId: Mapped to Claude SDK session resume for conversation continuity
 *   - runId: Used for event correlation in AG-UI protocol
 *   - messages: All validated; last message sent to SDK (SDK manages history)
 *   - tools: Dynamically added as "ag_ui" MCP server (stub implementations for frontend tools)
 *   - context: Injected into prompt as formatted text for agent awareness
 *   - state: Injected into prompt + ag_ui_update_state tool created for bidirectional sync
 *   - parentRunId: Passed through to RUN_STARTED for branching/lineage tracking
 *   - forwardedProps: Per-run option overrides (see ALLOWED_FORWARDED_PROPS for whitelist)
 *
 * Frontend Tool Execution (Human-in-the-Loop Pattern):
 *   When Claude calls a frontend tool (tool name matches input.tools):
 *   1. Backend emits TOOL_CALL_START/ARGS/END events (streaming arguments)
 *   2. Backend HALTS stream immediately after TOOL_CALL_END
 *   3. Client executes tool handler with complete arguments
 *   4. Client sends ToolMessage back in NEXT RunAgentInput.messages
 *   5. Backend resumes conversation with tool result
 *
 * @example
 * ```typescript
 * const adapter = new ClaudeAgentAdapter({
 *   agentId: "my_agent",
 *   description: "A helpful assistant",
 *   model: "claude-haiku-4-5",
 *   systemPrompt: "You are helpful",
 * });
 *
 * const events$ = adapter.run(runAgentInput);
 * events$.subscribe({
 *   next: (event) => console.log(event),
 *   complete: () => console.log("Done"),
 * });
 * ```
 */
export class ClaudeAgentAdapter extends AbstractAgent {
  private config: ClaudeAgentAdapterConfig;
  private apiKey: string;
  private activeQuery: Query | null = null;

  /** Track Claude SDK session IDs per thread (for session resumption) */
  private sessionIdsByThread: Map<string, string> = new Map();

  /** Current state tracking per run (for state management) */
  private currentState: unknown = null;

  /** Result data from last run (for RunFinished event) */
  private lastResultData: Record<string, unknown> | undefined;

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
    cloned.activeQuery = null;
    cloned.sessionIdsByThread = new Map(this.sessionIdsByThread);
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
        // Cleanup on unsubscribe
      };
    });
  }

  private async runAgentStream(
    input: RunAgentInput,
    subscriber: Subscriber<ProcessedEvent>
  ): Promise<void> {
    const threadId = input.threadId ?? randomUUID();
    const runId = input.runId ?? randomUUID();

    // Clear result data from any previous run
    this.lastResultData = undefined;

    // Initialize state tracking for this run (only if meaningful state provided)
    this.currentState = hasState(input.state) ? input.state : null;

    try {
      // Log parentRunId if provided (for branching/time travel tracking)
      if (input.parentRunId) {
        console.debug(
          `[ClaudeAdapter] Run ${runId.slice(0, 8)}... is branched from parent run ${input.parentRunId.slice(0, 8)}...`
        );
      }

      // Emit RUN_STARTED with input capture (following LangGraph pattern)
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId,
      });

      // Process all messages and extract user message
      const { userMessage, hasPendingToolResult } = processMessages(input);

      // Extract frontend tool names for halt detection (like Strands pattern)
      const frontendToolNames = new Set(
        input.tools?.length ? extractToolNames(input.tools) : []
      );
      if (frontendToolNames.size > 0) {
        console.debug(
          `[ClaudeAdapter] Frontend tools detected: ${[...frontendToolNames].join(", ")}`
        );
      }

      // Inject state and context into the prompt
      const enhancedPrompt = injectStateAndContextIntoPrompt(
        userMessage,
        input
      );

      // Log tools from input
      if (input.tools?.length) {
        const toolNames = extractToolNames(input.tools);
        console.debug(
          `[ClaudeAdapter] Client provided ${input.tools.length} frontend tools: [${toolNames.join(", ")}]. Creating dynamic ag_ui MCP server.`
        );
      }

      // Log forwardedProps for debugging (skip empty objects from CopilotKit runtime)
      if (hasState(input.forwardedProps)) {
        console.debug(
          `[ClaudeAdapter] Received forwardedProps:`,
          input.forwardedProps
        );
      }

      if (!userMessage) {
        console.warn("[ClaudeAdapter] No user message found in input");
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
        });
        subscriber.complete();
        return;
      }

      // Emit initial state snapshot if provided (skip empty objects from CopilotKit runtime)
      if (hasState(input.state)) {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: input.state,
        });
      }

      // Run Claude SDK and emit events
      await this.streamClaudeSdk(
        enhancedPrompt,
        threadId,
        runId,
        input,
        hasPendingToolResult,
        frontendToolNames,
        subscriber
      );

      // Emit RUN_FINISHED with result data from ResultMessage
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        result: this.lastResultData,
      });

      subscriber.complete();
    } catch (error) {
      console.error(`[ClaudeAdapter] Error in runAgentStream:`, error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack =
        error instanceof Error ? error.stack : undefined;

      subscriber.next({
        type: EventType.RUN_ERROR,
        threadId,
        runId,
        message: `${errorMessage}${errorStack ? "\n\nStack: " + errorStack : ""}`,
      });
      subscriber.complete();
    }
  }

  /**
   * Build Options by merging base config + dynamic MCP server from input.tools
   * + state management tool + forwardedProps overrides + auto-granted tool permissions.
   */
  private buildOptions(input: RunAgentInput): Options {
    // Start with sensible defaults
    const merged: Record<string, unknown> = {
      includePartialMessages: true,
    };

    // Merge in base config (excluding AG-UI specific fields)
    const {
      apiKey: _apiKey,
      agentId: _agentId,
      description: _desc,
      threadId: _threadId,
      initialMessages: _msgs,
      initialState: _state,
      debug: _debug,
      ...sdkOptions
    } = this.config;

    for (const [key, value] of Object.entries(sdkOptions)) {
      if (value != null) {
        merged[key] = value;
      }
    }

    // Ensure ag_ui tools are always allowed (frontend tools + state management)
    if (hasState(input.state) || input.tools?.length) {
      const allowedTools = (merged.allowedTools as string[]) ?? [];
      const toolsToAdd: string[] = [];

      // Add state management tool if state is provided
      if (
        hasState(input.state) &&
        !allowedTools.includes(STATE_MANAGEMENT_TOOL_FULL_NAME)
      ) {
        toolsToAdd.push(STATE_MANAGEMENT_TOOL_FULL_NAME);
      }

      // Add frontend tools (prefixed with mcp__ag_ui__)
      if (input.tools?.length) {
        for (const toolName of extractToolNames(input.tools)) {
          const prefixedName = `mcp__ag_ui__${toolName}`;
          if (!allowedTools.includes(prefixedName)) {
            toolsToAdd.push(prefixedName);
          }
        }
      }

      if (toolsToAdd.length > 0) {
        merged.allowedTools = [...allowedTools, ...toolsToAdd];
        console.debug(
          `[ClaudeAdapter] Auto-granted permission to ag_ui tools: [${toolsToAdd.join(", ")}]`
        );
      }
    }

    // Remove apiKey from options (handled via environment variable)
    delete merged.apiKey;

    // Apply forwardedProps as per-run overrides (skip empty objects)
    if (hasState(input.forwardedProps)) {
      applyForwardedProps(
        input.forwardedProps as Record<string, unknown>,
        merged,
        ALLOWED_FORWARDED_PROPS
      );
    }

    // Add dynamic tools from input.tools and state management
    const existingServers = (merged.mcpServers ?? {}) as Record<
      string,
      unknown
    >;
    const agUiTools: ReturnType<typeof convertAguiToolToClaudeSdk>[] = [];

    // Add frontend tools from input.tools
    if (input.tools?.length) {
      console.debug(
        `[ClaudeAdapter] Building dynamic MCP server with ${input.tools.length} frontend tools`
      );
      for (const toolDef of input.tools) {
        try {
          agUiTools.push(convertAguiToolToClaudeSdk(toolDef));
        } catch (e) {
          console.warn(`[ClaudeAdapter] Failed to convert tool:`, e);
        }
      }
    }

    // Add state management tool if meaningful state is provided
    if (hasState(input.state)) {
      console.debug(
        "[ClaudeAdapter] Adding ag_ui_update_state tool for state management"
      );
      agUiTools.push(createStateManagementTool());
    }

    // Create ag_ui MCP server if we have any tools
    if (agUiTools.length > 0) {
      const agUiServer = createSdkMcpServer({
        name: AG_UI_MCP_SERVER_NAME,
        version: "1.0.0",
        tools: agUiTools,
      });

      merged.mcpServers = {
        ...existingServers,
        [AG_UI_MCP_SERVER_NAME]: agUiServer,
      };

      console.debug(
        `[ClaudeAdapter] Created ag_ui MCP server with ${agUiTools.length} tools`
      );
    }

    return merged as Options;
  }

  /**
   * Execute the Claude SDK with the given prompt and emit AG-UI events.
   */
  private async streamClaudeSdk(
    prompt: string,
    threadId: string,
    runId: string,
    input: RunAgentInput,
    hasPendingToolResult: boolean,
    frontendToolNames: Set<string>,
    subscriber: Subscriber<ProcessedEvent>
  ): Promise<void> {
    // Per-run state (local to this invocation)
    let currentMessageId: string | null = null;
    let inThinkingBlock = false;
    let hasStreamedText = false;

    // Tool call streaming state
    let currentToolCallId: string | null = null;
    let currentToolCallName: string | null = null;
    let currentToolDisplayName: string | null = null; // Unprefixed name for frontend matching
    let accumulatedToolJson = ""; // Accumulate partial JSON for tool arguments

    // Track which tools we've already emitted START for (to avoid duplicates)
    const processedToolIds = new Set<string>();

    // Frontend tool halt flag (like Strands pattern)
    let haltEventStream = false;

    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY must be set");
    }

    // Set environment variable for SDK
    process.env.ANTHROPIC_API_KEY = this.apiKey;

    // Build options dynamically from base config + input tools + state
    const options = this.buildOptions(input);

    // Check if we have an existing session for this thread (for resumption)
    const existingSessionId = this.sessionIdsByThread.get(threadId);

    // Build query options with session resumption if available
    const queryOptions: Options = {
      ...options,
      model: options.model ?? this.config.model ?? "claude-sonnet-4-20250514",
      env: {
        ...process.env,
        ...(options.env ?? {}),
        ANTHROPIC_API_KEY: this.apiKey,
      },
    };

    // Resume existing session if we have one
    if (existingSessionId) {
      console.debug(
        `[ClaudeAdapter] Resuming existing session ${existingSessionId.slice(0, 8)}... for thread ${threadId.slice(0, 8)}...`
      );
      queryOptions.resume = existingSessionId;
    } else {
      console.debug(
        `[ClaudeAdapter] Starting new session for thread ${threadId.slice(0, 8)}... (messageCount=${input.messages?.length ?? 0}, hasToolResult=${hasPendingToolResult})`
      );
    }

    // Create query
    const queryStream = query({
      prompt,
      options: queryOptions,
    });

    // Track active query for interrupt support
    this.activeQuery = queryStream;

    try {
      // Process response stream
      let messageCount = 0;

      for await (const message of queryStream) {
        messageCount++;

        // If we've halted due to frontend tool, break out of loop
        if (haltEventStream) {
          console.debug(
            `[ClaudeAdapter] [Message #${messageCount}]: Halted - breaking stream loop`
          );
          break;
        }

        // Handle streaming events
        if (message.type === "stream_event") {
          const streamMsg = message as SDKPartialAssistantMessage;
          const event = streamMsg.event as unknown as Record<string, unknown>;
          const eventType = event.type as string;

          if (eventType === "message_start") {
            // Create message_id but DON'T emit TEXT_MESSAGE_START yet
            // We'll emit it when we get actual text content (text_delta)
            // This prevents empty text messages when only thinking blocks appear
            currentMessageId = randomUUID();
            hasStreamedText = false; // Reset for new message!
            console.debug(
              `[ClaudeAdapter] Message starting (messageId=${currentMessageId.slice(0, 8)}...), waiting for content...`
            );
          } else if (eventType === "content_block_delta") {
            const delta = (event.delta as Record<string, unknown>) ?? {};
            const deltaType = delta.type as string;

            if (deltaType === "text_delta") {
              const text = delta.text as string | undefined;
              if (text && currentMessageId) {
                // Emit TEXT_MESSAGE_START on first text content (lazy emission)
                if (!hasStreamedText) {
                  console.debug(
                    `[ClaudeAdapter] First text content - emitting TEXT_MESSAGE_START (messageId=${currentMessageId.slice(0, 8)}...)`
                  );
                  subscriber.next({
                    type: EventType.TEXT_MESSAGE_START,
                    threadId,
                    runId,
                    messageId: currentMessageId,
                    role: "assistant",
                  });
                }
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
                subscriber.next({
                  type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
                  delta: thinking,
                });
              }
            } else if (deltaType === "input_json_delta") {
              // Handle streaming tool arguments
              const partialJson = delta.partial_json as string | undefined;
              if (partialJson && currentToolCallId) {
                // Accumulate JSON for potential parsing
                accumulatedToolJson += partialJson;

                // Emit TOOL_CALL_ARGS with the delta
                subscriber.next({
                  type: EventType.TOOL_CALL_ARGS,
                  threadId,
                  runId,
                  toolCallId: currentToolCallId,
                  delta: partialJson,
                });
              }
            }
          } else if (eventType === "content_block_start") {
            const block =
              (event.content_block as Record<string, unknown>) ?? {};

            if (block.type === "thinking") {
              inThinkingBlock = true;
              console.debug(
                "[ClaudeAdapter] Opening thinking block - emitting THINKING_START and THINKING_TEXT_MESSAGE_START"
              );
              // Emit THINKING_START to mark beginning of thinking session
              subscriber.next({
                type: EventType.THINKING_START,
              });
              subscriber.next({
                type: EventType.THINKING_TEXT_MESSAGE_START,
              });
            } else if (block.type === "tool_use") {
              // Tool call starting - emit TOOL_CALL_START
              currentToolCallId = (block.id as string) ?? null;
              currentToolCallName =
                (block.name as string) ?? "unknown";
              accumulatedToolJson = "";

              if (currentToolCallId) {
                console.debug(
                  `[ClaudeAdapter] Tool call streaming started: ${currentToolCallName}`
                );

                // Strip MCP prefix from ALL tools for client matching
                currentToolDisplayName = stripMcpPrefix(
                  currentToolCallName
                );
                if (currentToolDisplayName !== currentToolCallName) {
                  console.debug(
                    `[ClaudeAdapter] Stripped MCP prefix: ${currentToolCallName} -> ${currentToolDisplayName}`
                  );
                }

                // Mark as processed
                processedToolIds.add(currentToolCallId);

                subscriber.next({
                  type: EventType.TOOL_CALL_START,
                  threadId,
                  runId,
                  toolCallId: currentToolCallId,
                  toolCallName: currentToolDisplayName, // Use unprefixed name for frontend matching!
                  parentMessageId: currentMessageId ?? undefined, // Link to parent message
                });
              }
            }
          } else if (eventType === "content_block_stop") {
            // Close thinking block if we were in one
            if (inThinkingBlock) {
              inThinkingBlock = false;
              console.debug(
                "[ClaudeAdapter] Closing thinking block - emitting THINKING_TEXT_MESSAGE_END and THINKING_END"
              );
              subscriber.next({
                type: EventType.THINKING_TEXT_MESSAGE_END,
              });
              subscriber.next({
                type: EventType.THINKING_END,
              });
            }

            // Close tool call if we were streaming one
            if (currentToolCallId) {
              // Check if this is the state management tool
              if (
                currentToolCallName === STATE_MANAGEMENT_TOOL_NAME ||
                currentToolCallName === STATE_MANAGEMENT_TOOL_FULL_NAME
              ) {
                // Parse accumulated JSON and emit STATE_SNAPSHOT
                try {
                  const stateArgs = JSON.parse(accumulatedToolJson);
                  if (typeof stateArgs === "object" && stateArgs !== null) {
                    let updates =
                      stateArgs.state_updates ?? stateArgs;

                    // Parse nested JSON string if needed
                    if (typeof updates === "string") {
                      updates = JSON.parse(updates);
                    }

                    // Update current state
                    if (
                      typeof this.currentState === "object" &&
                      this.currentState !== null &&
                      typeof updates === "object" &&
                      updates !== null
                    ) {
                      this.currentState = {
                        ...(this.currentState as Record<string, unknown>),
                        ...(updates as Record<string, unknown>),
                      };
                    } else {
                      this.currentState = updates;
                    }

                    // Emit STATE_SNAPSHOT
                    subscriber.next({
                      type: EventType.STATE_SNAPSHOT,
                      snapshot: this.currentState,
                    });
                    console.debug(
                      "[ClaudeAdapter] Emitted streamed STATE_SNAPSHOT"
                    );
                  }
                } catch {
                  console.warn(
                    "[ClaudeAdapter] Failed to parse tool JSON for state update"
                  );
                }
              }

              // Check if this is a frontend tool (using unprefixed name for comparison)
              const isFrontendTool =
                currentToolDisplayName != null &&
                frontendToolNames.has(currentToolDisplayName);

              if (isFrontendTool) {
                // Emit TOOL_CALL_END for frontend tool
                subscriber.next({
                  type: EventType.TOOL_CALL_END,
                  threadId,
                  runId,
                  toolCallId: currentToolCallId,
                });

                // Close any active text message before interrupting
                // ONLY if we actually emitted TEXT_MESSAGE_START
                if (currentMessageId && hasStreamedText) {
                  subscriber.next({
                    type: EventType.TEXT_MESSAGE_END,
                    threadId,
                    runId,
                    messageId: currentMessageId,
                  });
                  console.debug(
                    `[ClaudeAdapter] Closed text message before interrupt (messageId=${currentMessageId.slice(0, 8)}...)`
                  );
                  currentMessageId = null;
                }

                console.debug(
                  `[ClaudeAdapter] Frontend tool completed: ${currentToolDisplayName}. INTERRUPTING Claude SDK stream for client execution.`
                );

                // INTERRUPT the Claude SDK stream
                if (this.activeQuery) {
                  try {
                    await this.activeQuery.interrupt();
                    console.debug(
                      "[ClaudeAdapter] Successfully interrupted Claude SDK stream"
                    );
                  } catch (e) {
                    console.warn(
                      "[ClaudeAdapter] Failed to interrupt stream:",
                      e
                    );
                  }
                }

                haltEventStream = true;
                continue;
              }

              // For regular backend tools, emit TOOL_CALL_END here.
              // The Claude SDK executes backend tools internally and returns the result
              // in a subsequent message. The TS SDK's SDKUserMessage synthetic handler
              // is unreliable for detecting tool results, so we close the tool call now.
              // (Python doesn't need this because ToolResultBlock comes through reliably.)
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                threadId,
                runId,
                toolCallId: currentToolCallId,
              });
              console.debug(
                `[ClaudeAdapter] Emitted TOOL_CALL_END for backend tool: ${currentToolDisplayName}`
              );

              // Track that we already emitted END for this tool (so SDKUserMessage handler skips duplicate)
              processedToolIds.add(currentToolCallId);

              // Reset tool streaming state
              currentToolCallId = null;
              currentToolCallName = null;
              currentToolDisplayName = null;
              accumulatedToolJson = "";
            }
          } else if (eventType === "message_stop") {
            // End the current text message ONLY if we actually started one
            if (currentMessageId && hasStreamedText) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                threadId,
                runId,
                messageId: currentMessageId,
              });
              console.debug(
                `[ClaudeAdapter] Closed text message (messageId=${currentMessageId.slice(0, 8)}...)`
              );
            } else if (currentMessageId && !hasStreamedText) {
              console.debug(
                "[ClaudeAdapter] Message ended with no text content (thinking-only) - not emitting TEXT_MESSAGE_END"
              );
            }
            currentMessageId = null;
            // NOTE: Don't reset hasStreamedText here!
          } else if (eventType === "message_delta") {
            // Handle message-level delta (e.g., stop_reason, usage)
            const delta = (event.delta as Record<string, unknown>) ?? {};
            const stopReason = delta.stop_reason as string | undefined;
            if (stopReason) {
              console.debug(
                `[ClaudeAdapter] Message stop_reason: ${stopReason}`
              );
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

              if (toolId && processedToolIds.has(toolId)) {
                // We already emitted START/ARGS during streaming - skip duplicate
                console.debug(
                  `[ClaudeAdapter] ToolUseBlock already processed (streamed): ${toolBlock.name}`
                );
              } else {
                // New tool - emit events (nested tools, non-streamed tools, etc.)
                console.debug(
                  `[ClaudeAdapter] Processing ToolUseBlock: ${toolBlock.name}`
                );
                const parentToolUseId =
                  assistantMsg.parent_tool_use_id;
                const { updatedState } = handleToolUseBlock(
                  toolBlock,
                  parentToolUseId ?? undefined,
                  threadId,
                  runId,
                  this.currentState,
                  subscriber
                );

                if (toolId) {
                  processedToolIds.add(toolId);
                }

                if (updatedState !== null) {
                  this.currentState = updatedState;
                }
              }
            }

            // Handle thinking blocks (already streamed via thinking_delta)
            if (block.type === "thinking") {
              const thinkingBlock = block as BetaThinkingBlock;
              const thinkingText = thinkingBlock.thinking;
              if (thinkingText) {
                console.debug(
                  `[ClaudeAdapter] ThinkingBlock received (already streamed), length=${thinkingText.length}`
                );
              }
            }

            // NOTE: tool_result blocks don't appear in AssistantMessage content in the TS SDK.
            // They come through SDKUserMessage (synthetic) path, which is handled below.
          }
        }
        // Handle user messages (may contain tool results)
        else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;

          // Look for tool_result blocks in user message content.
          // The TS SDK sends tool results as synthetic user messages.
          // We check multiple paths since SDK versions may differ:
          // 1. isSynthetic + tool_use_result (documented SDK properties)
          // 2. Direct content inspection (fallback for SDK variations)
          const msgContent = (userMsg.message ?? userMsg) as {
            content?: unknown[];
          };
          const contentBlocks = msgContent.content;

          if (Array.isArray(contentBlocks)) {
            for (const blk of contentBlocks) {
              const block = blk as Record<string, unknown>;
              if (block.type === "tool_result" && block.tool_use_id) {
                const toolUseId = block.tool_use_id as string;

                // TOOL_CALL_END was already emitted at content_block_stop.
                // Only emit TOOL_CALL_RESULT here for the result content.
                const resultContent = block.content;
                let resultStr = "";
                try {
                  if (Array.isArray(resultContent) && resultContent.length > 0) {
                    const firstBlock = resultContent[0] as Record<string, unknown>;
                    if (firstBlock?.type === "text") {
                      const textContent = (firstBlock.text as string) ?? "";
                      try {
                        resultStr = JSON.stringify(JSON.parse(textContent));
                      } catch {
                        resultStr = textContent;
                      }
                    } else {
                      resultStr = JSON.stringify(resultContent);
                    }
                  } else if (resultContent != null) {
                    resultStr = JSON.stringify(resultContent);
                  }
                } catch {
                  resultStr = String(resultContent ?? "");
                }

                subscriber.next({
                  type: EventType.TOOL_CALL_RESULT,
                  threadId,
                  runId,
                  messageId: `${toolUseId}-result`,
                  toolCallId: toolUseId,
                  content: resultStr,
                  role: "tool",
                });

                console.debug(
                  `[ClaudeAdapter] Emitted TOOL_CALL_RESULT for backend tool: ${toolUseId.slice(0, 8)}...`
                );
              }
            }
          }
        }
        // Handle system messages
        else if (message.type === "system") {
          const raw = message as unknown as Record<string, unknown>;
          const subtype = raw.subtype as string | undefined;

          // Capture session_id for session resumption
          // TS SDK places session_id as a direct top-level property on system messages
          const sessionId = raw.session_id as string | undefined;
          if (sessionId && !this.sessionIdsByThread.has(threadId)) {
            this.sessionIdsByThread.set(threadId, sessionId);
            console.debug(
              `[ClaudeAdapter] Captured session_id ${sessionId.slice(0, 8)}... for thread ${threadId.slice(0, 8)}...`
            );
          }

          // Extract message content from data for system message display
          const data = raw.data as Record<string, unknown> | undefined;
          const msgText = (data?.message as string) ?? (data?.text as string) ?? "";
          if (msgText) {
            console.debug(`[ClaudeAdapter] SystemMessage: subtype=${subtype}`);
            emitSystemMessageEvents(subscriber, threadId, runId, msgText);
          }
        }
        // Handle result messages
        else if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;

          // Capture result data for RunFinished event (METADATA ONLY, not content!)
          this.lastResultData = {
            isError:
              (resultMsg as { is_error?: boolean }).is_error ?? false,
            // Don't include 'result' text - it was already streamed
            durationMs: (resultMsg as { duration_ms?: number })
              .duration_ms,
            durationApiMs: (resultMsg as { duration_api_ms?: number })
              .duration_api_ms,
            numTurns: (resultMsg as { num_turns?: number }).num_turns,
            totalCostUsd: (resultMsg as { total_cost_usd?: number })
              .total_cost_usd,
            usage:
              (resultMsg as { usage?: Record<string, unknown> })
                .usage ?? {},
            structuredOutput:
              (resultMsg as { structured_output?: unknown })
                .structured_output,
          };

          // Only display result text if we haven't streamed text (avoids duplicates)
          const resultText = (resultMsg as { result?: string }).result;
          if (!hasStreamedText && resultText) {
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
              delta: resultText,
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

      console.debug(
        `[ClaudeAdapter] Response stream completed (${messageCount} messages)`
      );

      // Log final session info
      const finalSessionId =
        this.sessionIdsByThread.get(threadId) ?? threadId;
      console.debug(
        `[ClaudeAdapter] Conversation state saved in .claude/ (sessionId=${finalSessionId.slice(0, 8)}..., threadId=${threadId.slice(0, 8)}...)`
      );
    } finally {
      this.activeQuery = null;
    }
  }
}
