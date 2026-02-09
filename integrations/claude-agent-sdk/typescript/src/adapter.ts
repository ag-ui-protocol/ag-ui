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
import type { BaseEvent, RunAgentInput, Message } from "@ag-ui/core";

import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  Options,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ClaudeAgentAdapterConfig, ProcessedEvent } from "./types";
import {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  STATE_MANAGEMENT_TOOL_FULL_NAME,
  AG_UI_MCP_SERVER_NAME,
} from "./config";
import {
  processMessages,
  buildStateContextAddendum,
  extractToolNames,
  stripMcpPrefix,
  convertAguiToolToClaudeSdk,
  createStateManagementTool,
  applyForwardedProps,
  hasState,
  buildAguiAssistantMessage,
  buildAguiToolMessage,
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
 *   - context: Appended to systemPrompt for agent awareness
 *   - state: Appended to systemPrompt + ag_ui_update_state tool created for bidirectional sync
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
      const { userMessage } = processMessages(input);

      // Extract frontend tool names for halt detection (like Strands pattern)
      const frontendToolNames = new Set(
        input.tools?.length ? extractToolNames(input.tools) : []
      );
      if (frontendToolNames.size > 0) {
        console.debug(
          `[ClaudeAdapter] Frontend tools detected (${frontendToolNames.size}): [${[...frontendToolNames].join(", ")}]. Creating dynamic ag_ui MCP server.`
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
        userMessage,
        threadId,
        runId,
        input,
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
   *
   * State and context from RunAgentInput are appended to the systemPrompt so
   * the agent is aware of them without polluting the user message.
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

    // Append state and context to the system prompt (not the user message).
    const addendum = buildStateContextAddendum(input);
    if (addendum) {
      const base = (merged.systemPrompt as string) ?? "";
      merged.systemPrompt = base ? `${base}\n\n${addendum}` : addendum;
      console.debug(
        `[ClaudeAdapter] Appended state/context (${addendum.length} chars) to systemPrompt`
      );
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
    frontendToolNames: Set<string>,
    subscriber: Subscriber<ProcessedEvent>
  ): Promise<void> {
    // Per-run state (local to this invocation)
    let currentMessageId: string | null = null;
    let inThinkingBlock = false;
    let hasStreamedText = false;
    let accumulatedThinkingText = "";

    // Tool call streaming state
    let currentToolCallId: string | null = null;
    let currentToolCallName: string | null = null;
    let currentToolDisplayName: string | null = null; // Unprefixed name for frontend matching
    let accumulatedToolJson = ""; // Accumulate partial JSON for tool arguments

    // Track which tools we've already emitted START for (to avoid duplicates)
    const processedToolIds = new Set<string>();

    // Frontend tool halt flag (like Strands pattern)
    let haltEventStream = false;

    // ── MESSAGES_SNAPSHOT accumulation ──
    // All message types go here. At the end we emit:
    //   MESSAGES_SNAPSHOT = [...input.messages, ...runMessages]
    const runMessages: Message[] = [];

    /** Upsert a message: replace if same ID exists, otherwise append. */
    const upsertMessage = (msg: Message) => {
      const idx = runMessages.findIndex((m) => m.id === msg.id);
      if (idx !== -1) {
        runMessages[idx] = msg;
      } else {
        runMessages.push(msg);
      }
    };

    // In-flight assistant message built from stream events.
    // Flushed into runMessages at message_stop (or frontend tool halt).
    type ToolCallEntry = { id: string; type: "function"; function: { name: string; arguments: string } };
    let pendingMsg: { id: string; content: string; toolCalls: ToolCallEntry[] } | null = null;

    /** Flush pendingMsg → runMessages (upsert so streaming version wins over fallback). */
    const flushPendingMsg = () => {
      if (!pendingMsg) return;
      if (pendingMsg.content || pendingMsg.toolCalls.length > 0) {
        upsertMessage({
          id: pendingMsg.id,
          role: "assistant" as const,
          ...(pendingMsg.content ? { content: pendingMsg.content } : {}),
          ...(pendingMsg.toolCalls.length > 0 ? { toolCalls: pendingMsg.toolCalls } : {}),
        });
      }
      pendingMsg = null;
    };

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

    if (existingSessionId) {
      queryOptions.resume = existingSessionId;
    }

    console.debug(
      `[ClaudeAdapter] ${existingSessionId ? 'Resuming' : 'Starting'} session for thread ${threadId.slice(0, 8)}...`
    );

    const queryStream = query({ prompt, options: queryOptions });
    this.activeQuery = queryStream;

    try {
      let messageCount = 0;

      for await (const message of queryStream) {
        messageCount++;
        if (haltEventStream) break;

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
            hasStreamedText = false;
            pendingMsg = { id: currentMessageId, content: "", toolCalls: [] };
          } else if (eventType === "content_block_delta") {
            const delta = (event.delta as Record<string, unknown>) ?? {};
            const deltaType = delta.type as string;

            if (deltaType === "text_delta") {
              const text = delta.text as string | undefined;
              if (text && currentMessageId) {
                if (!hasStreamedText) {
                  subscriber.next({
                    type: EventType.TEXT_MESSAGE_START,
                    threadId,
                    runId,
                    messageId: currentMessageId,
                    role: "assistant",
                  });
                }
                hasStreamedText = true;
                if (pendingMsg) pendingMsg.content += text;

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
                accumulatedThinkingText += thinking;
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
                currentToolDisplayName = stripMcpPrefix(currentToolCallName);
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
            if (inThinkingBlock) {
              inThinkingBlock = false;
              subscriber.next({ type: EventType.THINKING_TEXT_MESSAGE_END });
              subscriber.next({ type: EventType.THINKING_END });

              // Persist thinking content
              if (accumulatedThinkingText) {
                upsertMessage({
                  id: randomUUID(),
                  role: "developer" as const,
                  content: accumulatedThinkingText,
                });
                accumulatedThinkingText = "";
              }
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

                    subscriber.next({
                      type: EventType.STATE_SNAPSHOT,
                      snapshot: this.currentState,
                    });
                  }
                } catch {
                  console.warn(
                    "[ClaudeAdapter] Failed to parse tool JSON for state update"
                  );
                }
              }

              // Push tool call onto in-flight message (skip state management)
              if (
                pendingMsg &&
                currentToolCallId &&
                currentToolDisplayName &&
                currentToolCallName !== STATE_MANAGEMENT_TOOL_NAME &&
                currentToolCallName !== STATE_MANAGEMENT_TOOL_FULL_NAME
              ) {
                pendingMsg.toolCalls.push({
                  id: currentToolCallId,
                  type: "function" as const,
                  function: {
                    name: currentToolDisplayName,
                    arguments: accumulatedToolJson,
                  },
                });
              }

              // Check if this is a frontend tool (using unprefixed name for comparison)
              const isFrontendTool =
                currentToolDisplayName != null &&
                frontendToolNames.has(currentToolDisplayName);

              if (isFrontendTool) {
                // Flush before halt (message_stop won't fire after interrupt)
                flushPendingMsg();

                // Emit TOOL_CALL_END for frontend tool
                subscriber.next({
                  type: EventType.TOOL_CALL_END,
                  threadId,
                  runId,
                  toolCallId: currentToolCallId,
                });

                if (currentMessageId && hasStreamedText) {
                  subscriber.next({
                    type: EventType.TEXT_MESSAGE_END,
                    threadId,
                    runId,
                    messageId: currentMessageId,
                  });
                  currentMessageId = null;
                }

                console.debug(`[ClaudeAdapter] Frontend tool halt: ${currentToolDisplayName}`);

                if (this.activeQuery) {
                  try {
                    await this.activeQuery.interrupt();
                  } catch (e) {
                    console.warn("[ClaudeAdapter] Failed to interrupt stream:", e);
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

              currentToolCallId = null;
              currentToolCallName = null;
              currentToolDisplayName = null;
              accumulatedToolJson = "";
            }
          } else if (eventType === "message_stop") {
            flushPendingMsg();

            if (currentMessageId && hasStreamedText) {
              subscriber.next({
                type: EventType.TEXT_MESSAGE_END,
                threadId,
                runId,
                messageId: currentMessageId,
              });
            }
            currentMessageId = null;
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

          // Accumulate from the complete SDK message (fallback path).
          // Uses the streaming ID so flushPendingMsg() can replace it with
          // the richer streaming version (which has toolCalls).
          {
            const msgId = currentMessageId ?? randomUUID();
            const aguiMsg = buildAguiAssistantMessage(assistantMsg, msgId);
            if (aguiMsg) {
              upsertMessage(aguiMsg);
            }
          }

          // Process non-streamed tool_use blocks (fallback for tools not seen via stream events)
          for (const block of content) {
            if (block.type !== "tool_use") continue;
            const toolBlock = block as BetaToolUseBlock;
            if (toolBlock.id && processedToolIds.has(toolBlock.id)) continue;

            const { updatedState } = handleToolUseBlock(
              toolBlock,
              assistantMsg.parent_tool_use_id ?? undefined,
              threadId, runId, this.currentState, subscriber
            );
            if (toolBlock.id) processedToolIds.add(toolBlock.id);
            if (updatedState !== null) this.currentState = updatedState;
          }
        }
        // Handle user messages (may contain tool results)
        else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;

          const msgContent = (userMsg.message ?? userMsg) as {
            content?: unknown[];
          };
          const contentBlocks = msgContent.content;

          if (Array.isArray(contentBlocks)) {
            for (const blk of contentBlocks) {
              const block = blk as Record<string, unknown>;
              if (block.type === "tool_result" && block.tool_use_id) {
                const toolUseId = block.tool_use_id as string;
                const resultContent = block.content;

                // Build AG-UI tool message (reuse shared parsing logic)
                const toolMsg = buildAguiToolMessage(toolUseId, resultContent);
                upsertMessage(toolMsg);

                subscriber.next({
                  type: EventType.TOOL_CALL_RESULT,
                  threadId,
                  runId,
                  messageId: toolMsg.id,
                  toolCallId: toolUseId,
                  content: toolMsg.content as string,
                  role: "tool",
                });
              }
            }
          }
        }
        // Handle system messages
        else if (message.type === "system") {
          const raw = message as unknown as Record<string, unknown>;

          // Capture session_id for session resumption
          // TS SDK places session_id as a direct top-level property on system messages
          const sessionId = raw.session_id as string | undefined;
          if (sessionId && !this.sessionIdsByThread.has(threadId)) {
            this.sessionIdsByThread.set(threadId, sessionId);
          }

          const data = raw.data as Record<string, unknown> | undefined;
          const msgText = (data?.message as string) ?? (data?.text as string) ?? "";
          if (msgText) {
            const sysMsgId = randomUUID();
            emitSystemMessageEvents(subscriber, threadId, runId, msgText);

            upsertMessage({
              id: sysMsgId,
              role: "system" as const,
              content: msgText,
            });
          }
        }
        // Handle result messages
        else if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;

          // Capture metadata for RunFinished event
          this.lastResultData = {
            isError: (resultMsg as { is_error?: boolean }).is_error ?? false,
            durationMs: (resultMsg as { duration_ms?: number }).duration_ms,
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

          const resultText = (resultMsg as { result?: string }).result;
          if (!hasStreamedText && resultText) {
            const resultMsgId = randomUUID();
            subscriber.next({ type: EventType.TEXT_MESSAGE_START, threadId, runId, messageId: resultMsgId, role: "assistant" });
            subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, threadId, runId, messageId: resultMsgId, delta: resultText });
            subscriber.next({ type: EventType.TEXT_MESSAGE_END, threadId, runId, messageId: resultMsgId });

            upsertMessage({ id: resultMsgId, role: "assistant" as const, content: resultText });
          }
        }
      }

      // Emit MESSAGES_SNAPSHOT with input messages + new messages from this run
      if (runMessages.length > 0) {
        const allMessages: Message[] = [...(input.messages ?? []), ...runMessages];
        console.debug(
          `[ClaudeAdapter] MESSAGES_SNAPSHOT: ${allMessages.length} msgs (${messageCount} SDK messages processed)`
        );
        subscriber.next({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: allMessages,
        });
      }
    } finally {
      this.activeQuery = null;
    }
  }
}
