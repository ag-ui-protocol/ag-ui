/**
 * Cloudflare Agents SDK Integration for AG-UI
 *
 * Bridges the Cloudflare Agents SDK with AG-UI protocol, enabling
 * stateful agents with built-in SQL, state management, and scheduling
 * to work seamlessly with CopilotKit and other AG-UI frontends.
 */

import {
  EventType,
  type BaseEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type StateSnapshotEvent,
  type CustomEvent,
} from "@ag-ui/core";
import { v4 as uuidv4 } from "uuid";
import type { CloudflareMessage } from "./types";

/**
 * Base interface for Cloudflare Agents SDK Agent class
 * This represents the Agent class from 'agents' package
 */
export interface CloudflareAgentsSDKAgent {
  /** Agent instance ID */
  id: string;

  /** Set agent state (syncs with clients) */
  setState(state: Record<string, any>): Promise<void>;

  /** Get current agent state */
  getState(): Record<string, any>;

  /** Execute SQL queries on agent's embedded database */
  sql<T = any>(query: TemplateStringsArray, ...values: any[]): Promise<T[]>;

  /** Schedule a task to run later */
  schedule(when: string | Date | number, callback: string, data?: any): Promise<void>;

  /** Handle HTTP requests */
  onRequest?(request: Request): Promise<Response>;

  /** Handle WebSocket connections */
  onConnect?(websocket: WebSocket): void;

  /** Handle WebSocket messages */
  onMessage?(websocket: WebSocket, message: string | ArrayBuffer): void;

  /** Handle WebSocket close */
  onClose?(websocket: WebSocket, code: number, reason: string, wasClean: boolean): void;

  /** Handle chat messages (AIChatAgent) */
  onChatMessage?(message: string, context: any): AsyncGenerator<string>;
}

/**
 * Options for creating an Agents SDK adapter
 */
export interface AgentsSDKAdapterOptions {
  /** Agent instance to wrap */
  agent: CloudflareAgentsSDKAgent;

  /** Enable state synchronization via AG-UI events */
  syncState?: boolean;

  /** Emit SQL queries as metadata events */
  trackSQL?: boolean;

  /** Custom event transformer */
  transformEvent?: (event: AgentsSDKChunk) => BaseEvent | null;

  /** Thread ID for conversation tracking */
  threadId?: string;

  /** Run ID for execution tracking */
  runId?: string;
}

/**
 * Adapter that wraps a Cloudflare Agent and exposes AG-UI protocol
 *
 * @example
 * ```typescript
 * import { Agent } from 'agents';
 * import { CloudflareAgentsSDKAdapter } from 'ag-ui-cloudflare';
 *
 * export class MyAgent extends Agent {
 *   async onChatMessage(message: string) {
 *     await this.setState({ thinking: true });
 *     const result = await this.ai.chat(message);
 *     await this.sql`INSERT INTO history VALUES (${message}, ${result})`;
 *     return result;
 *   }
 * }
 *
 * // In your Worker
 * const agent = new MyAgent(state, env);
 * const adapter = new CloudflareAgentsSDKAdapter({ agent });
 *
 * for await (const event of adapter.execute(messages)) {
 *   // Stream AG-UI events
 * }
 * ```
 */
/**
 * Chunk types that can be received from Agents SDK
 */
interface AgentsSDKChunk {
  type?: "text" | "tool_call" | "tool_call_delta" | "tool_call_result" | "interrupt" | "state";
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    args?: any;
    argsChunk?: string;
    done?: boolean;
  };
  interrupt?: {
    name: string;
    value: any;
  };
  state?: Record<string, any>;
}

export class CloudflareAgentsSDKAdapter {
  private agent: CloudflareAgentsSDKAgent;
  private options: AgentsSDKAdapterOptions;
  private runCounter = 0;
  private stateListeners: Set<(state: any) => void> = new Set();
  private currentMessageId: string | null = null;
  private currentMessageType: "text" | "tool_call" | null = null;
  private currentToolCallId: string | null = null;
  private currentToolCallName: string | null = null;
  private runPaused = false;

  constructor(options: AgentsSDKAdapterOptions) {
    this.agent = options.agent;
    this.options = options;

    // Set up state sync if enabled
    if (options.syncState) {
      this.setupStateSync();
    }
  }

  /**
   * Execute agent with AG-UI protocol
   */
  async *execute(
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<BaseEvent> {
    const threadId = context?.threadId || this.options.threadId || `thread-${Date.now()}`;
    const runId = context?.runId || this.options.runId || this.generateRunId();

    try {
      // Emit run started
      const runStarted: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        timestamp: Date.now(),
      };
      yield runStarted;

      // Get initial state
      if (this.options.syncState) {
        const initialState = this.agent.getState();
        const stateSnapshot: StateSnapshotEvent = {
          type: EventType.STATE_SNAPSHOT,
          snapshot: initialState,
          timestamp: Date.now(),
        };
        yield stateSnapshot;
      }

      // Check if agent has onChatMessage (AIChatAgent)
      if (typeof (this.agent as any).onChatMessage === "function") {
        yield* this.handleChatAgent(messages, context);
      } else {
        // Handle as generic agent
        yield* this.handleGenericAgent(messages, context);
      }

      // Emit final state if changed
      if (this.options.syncState) {
        const finalState = this.agent.getState();
        const stateSnapshot: StateSnapshotEvent = {
          type: EventType.STATE_SNAPSHOT,
          snapshot: finalState,
          timestamp: Date.now(),
        };
        yield stateSnapshot;
      }

      // Only emit RUN_FINISHED if run wasn't paused (HITL)
      if (!this.runPaused) {
        const runFinished: RunFinishedEvent = {
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          timestamp: Date.now(),
        };
        yield runFinished;
      }

      // Reset pause flag for next run
      this.runPaused = false;
    } catch (error) {
      const runError: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
        timestamp: Date.now(),
      };
      yield runError;
      throw error;
    }
  }

  /**
   * Handle AIChatAgent (has onChatMessage method)
   * Enhanced to support tool calls, interrupts, and proper event streaming
   * Pattern inspired by LangGraph's handleSingleEvent
   */
  private async *handleChatAgent(
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<BaseEvent> {
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "user") {
      throw new Error("Last message must be from user");
    }

    // Reset message tracking
    this.currentMessageId = null;
    this.currentMessageType = null;
    this.currentToolCallId = null;
    this.currentToolCallName = null;

    // Stream from agent's onChatMessage
    const agent = this.agent as any;
    const stream = agent.onChatMessage(lastMessage.content, {
      messages,
      ...context,
    });

    for await (const chunk of stream) {
      // Handle different chunk types
      yield* this.handleSingleChunk(chunk);
    }

    // End any message in progress
    if (this.currentMessageType === "text" && this.currentMessageId) {
      const textEnd: TextMessageEndEvent = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.currentMessageId,
        timestamp: Date.now(),
      };
      yield textEnd;
    } else if (this.currentMessageType === "tool_call" && this.currentToolCallId) {
      const toolEnd: ToolCallEndEvent = {
        type: EventType.TOOL_CALL_END,
        toolCallId: this.currentToolCallId,
        timestamp: Date.now(),
      };
      yield toolEnd;
    }
    this.currentMessageId = null;
    this.currentMessageType = null;
    this.currentToolCallId = null;
    this.currentToolCallName = null;
  }

  /**
   * Handle a single chunk from the Agents SDK stream
   * Detects and emits appropriate AG-UI events
   */
  private async *handleSingleChunk(
    chunk: any,
  ): AsyncGenerator<BaseEvent> {
    // Normalize chunk to our interface
    const normalizedChunk = this.normalizeChunk(chunk);

    // Handle tool call start (only if not done)
    if (normalizedChunk.type === "tool_call" && normalizedChunk.toolCall && !normalizedChunk.toolCall.done) {
      const { id, name } = normalizedChunk.toolCall;

      // End any text message in progress
      if (this.currentMessageType === "text" && this.currentMessageId) {
        const textEnd: TextMessageEndEvent = {
          type: EventType.TEXT_MESSAGE_END,
          messageId: this.currentMessageId,
          timestamp: Date.now(),
        };
        yield textEnd;
      }

      // Start tool call only if not already started
      if (this.currentToolCallId !== id) {
        const toolStart: ToolCallStartEvent = {
          type: EventType.TOOL_CALL_START,
          toolCallId: id,
          toolCallName: name,
          timestamp: Date.now(),
        };
        yield toolStart;

        this.currentMessageId = this.generateMessageId();
        this.currentMessageType = "tool_call";
        this.currentToolCallId = id;
        this.currentToolCallName = name;
      }
    }

    // Handle tool call arguments (delta)
    if (normalizedChunk.type === "tool_call_delta" && normalizedChunk.toolCall) {
      if (this.currentMessageType === "tool_call" && this.currentToolCallId) {
        const argsChunk = normalizedChunk.toolCall.argsChunk || "";

        const toolArgs: ToolCallArgsEvent = {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: this.currentToolCallId,
          delta: argsChunk,
          timestamp: Date.now(),
        };
        yield toolArgs;
      }
    }

    // Handle tool call end
    if (normalizedChunk.type === "tool_call" && normalizedChunk.toolCall?.done) {
      if (this.currentMessageType === "tool_call" && this.currentToolCallId) {
        // If we have accumulated args, emit them as final args
        if (normalizedChunk.toolCall.args) {
          const argsString = typeof normalizedChunk.toolCall.args === "string"
            ? normalizedChunk.toolCall.args
            : JSON.stringify(normalizedChunk.toolCall.args);

          const toolArgs: ToolCallArgsEvent = {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: this.currentToolCallId,
            delta: argsString,
            timestamp: Date.now(),
          };
          yield toolArgs;
        }

        const toolEnd: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId: this.currentToolCallId,
          timestamp: Date.now(),
        };
        yield toolEnd;
        this.currentMessageType = null;
        this.currentToolCallId = null;
        this.currentToolCallName = null;
      }
    }

    // Handle tool call result
    if (normalizedChunk.type === "tool_call_result" && normalizedChunk.toolCall) {
      const result = typeof normalizedChunk.toolCall.args === "string"
        ? normalizedChunk.toolCall.args
        : JSON.stringify(normalizedChunk.toolCall.args);

      const messageId = uuidv4();
      const toolResult: ToolCallResultEvent = {
        type: EventType.TOOL_CALL_RESULT,
        messageId,
        toolCallId: normalizedChunk.toolCall.id,
        content: result,
        timestamp: Date.now(),
      };
      yield toolResult;
    }

    // Handle interrupt (requiresApproval, human-in-the-loop)
    if (normalizedChunk.type === "interrupt" && normalizedChunk.interrupt) {
      const customEvent: CustomEvent = {
        type: EventType.CUSTOM,
        name: "OnInterrupt",
        value: normalizedChunk.interrupt.value,
        timestamp: Date.now(),
      };
      yield customEvent;
    }

    // Handle text content
    if (normalizedChunk.type === "text" && normalizedChunk.content) {
      // End any tool call in progress
      if (this.currentMessageType === "tool_call" && this.currentToolCallId) {
        const toolEnd: ToolCallEndEvent = {
          type: EventType.TOOL_CALL_END,
          toolCallId: this.currentToolCallId,
          timestamp: Date.now(),
        };
        yield toolEnd;
        this.currentToolCallId = null;
        this.currentToolCallName = null;
      }

      // Start text message if not in progress
      if (this.currentMessageType !== "text") {
        this.currentMessageId = this.generateMessageId();
        this.currentMessageType = "text";
        const textStart: TextMessageStartEvent = {
          type: EventType.TEXT_MESSAGE_START,
          messageId: this.currentMessageId,
          role: "assistant",
          timestamp: Date.now(),
        };
        yield textStart;
      }

      // Emit text content
      const textContent: TextMessageContentEvent = {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: this.currentMessageId!,
        delta: normalizedChunk.content,
        timestamp: Date.now(),
      };
      yield textContent;
    }

    // Handle state updates
    if (normalizedChunk.type === "state" && normalizedChunk.state) {
      // Check if run is paused (HITL)
      if (normalizedChunk.state.runStatus === "paused_for_approval") {
        this.runPaused = true;
      }

      const stateSnapshot: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: normalizedChunk.state,
        timestamp: Date.now(),
      };
      yield stateSnapshot;
    }
  }

  /**
   * Normalize different chunk formats to our standard interface
   * Agents SDK might return plain strings, objects, or structured chunks
   */
  private normalizeChunk(chunk: any): AgentsSDKChunk {
    // Plain string → text chunk
    if (typeof chunk === "string") {
      return { type: "text", content: chunk };
    }

    // Already normalized
    if (chunk.type) {
      return chunk as AgentsSDKChunk;
    }

    // Object with tool_call field (OpenAI-style)
    if (chunk.tool_call || chunk.toolCall) {
      const toolCall = chunk.tool_call || chunk.toolCall;
      return {
        type: toolCall.done ? "tool_call" : "tool_call_delta",
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args || toolCall.arguments,
          argsChunk: toolCall.args_chunk || toolCall.argsChunk,
          done: toolCall.done,
        },
      };
    }

    // Object with interrupt field (requiresApproval)
    if (chunk.interrupt || chunk.__interrupt__) {
      const interrupt = chunk.interrupt || chunk.__interrupt__;
      return {
        type: "interrupt",
        interrupt: {
          name: interrupt.name || "requiresApproval",
          value: interrupt.value || interrupt,
        },
      };
    }

    // Object with content field
    if (chunk.content !== undefined) {
      return { type: "text", content: String(chunk.content) };
    }

    // Object with delta field
    if (chunk.delta) {
      return { type: "text", content: String(chunk.delta) };
    }

    // Default: try to stringify
    return { type: "text", content: JSON.stringify(chunk) };
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Handle generic Agent (manual message processing)
   */
  private async *handleGenericAgent(
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<BaseEvent> {
    // For generic agents, we need to manually process
    // This would typically involve calling agent methods

    const messageId = this.generateMessageId();

    const textStart: TextMessageStartEvent = {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      timestamp: Date.now(),
    };
    yield textStart;

    const response = await this.processMessages(messages, context);

    const textContent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: response,
      timestamp: Date.now(),
    };
    yield textContent;

    const textEnd: TextMessageEndEvent = {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      timestamp: Date.now(),
    };
    yield textEnd;
  }

  /**
   * Process messages through the agent
   * Override this in subclasses for custom behavior
   */
  protected async processMessages(
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): Promise<string> {
    // Default implementation - override in subclass
    const lastMessage = messages[messages.length - 1];
    return `Agent processed: ${lastMessage?.content || "No message"}`;
  }

  /**
   * Create WebSocket handler for real-time communication
   */
  createWebSocketHandler(): (websocket: WebSocket, message: any) => Promise<void> {
    return async (websocket: WebSocket, message: any) => {
      try {
        const data = JSON.parse(
          typeof message === "string" ? message : new TextDecoder().decode(message),
        );

        if (data.type === "chat" && data.messages) {
          // Stream AG-UI events over WebSocket
          for await (const event of this.execute(data.messages, data.context)) {
            websocket.send(JSON.stringify(event));
          }
        } else if (data.type === "getState") {
          // Send current state
          const state = this.agent.getState();
          websocket.send(
            JSON.stringify({
              type: "STATE_SYNC",
              data: { state },
            }),
          );
        }
      } catch (error) {
        websocket.send(
          JSON.stringify({
            type: "RUN_ERROR",
            data: { error: error instanceof Error ? error.message : "Unknown error" },
          }),
        );
      }
    };
  }

  /**
   * Set up state synchronization
   */
  private setupStateSync(): void {
    // Intercept setState calls to emit events
    const originalSetState = this.agent.setState.bind(this.agent);

    this.agent.setState = async (state: Record<string, any>) => {
      await originalSetState(state);

      // Notify listeners
      for (const listener of this.stateListeners) {
        listener(state);
      }
    };
  }

  /**
   * Subscribe to state changes
   */
  onStateChange(callback: (state: any) => void): () => void {
    this.stateListeners.add(callback);

    // Return unsubscribe function
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * Execute SQL query and optionally emit as metadata event
   */
  async executeSQLWithTracking(query: TemplateStringsArray, ...values: any[]): Promise<any[]> {
    const result = await this.agent.sql(query, ...values);

    // TODO: Implement SQL tracking by emitting metadata events when trackSQL is enabled
    // This would require an event emitter or storing events to be yielded later

    return result;
  }

  private generateRunId(): string {
    return `agent-run-${Date.now()}-${++this.runCounter}`;
  }
}

/**
 * Helper function to create an Agents SDK adapter from an agent instance
 */
export function createAgentsSDKAdapter(
  agent: CloudflareAgentsSDKAgent,
  options?: Partial<AgentsSDKAdapterOptions>,
): CloudflareAgentsSDKAdapter {
  return new CloudflareAgentsSDKAdapter({
    agent,
    syncState: true,
    trackSQL: false,
    ...options,
  });
}

/**
 * Create a Worker fetch handler that uses Agents SDK + AG-UI
 */
export function createAgentsSDKWorkerHandler(
  agentFactory: (state: DurableObjectState, env: any) => CloudflareAgentsSDKAgent,
  options?: Partial<AgentsSDKAdapterOptions>,
): {
  fetch: (request: Request, env: any, ctx: ExecutionContext) => Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      // This would typically get the Durable Object instance
      // For now, provide a basic HTTP handler structure

      if (request.method === "POST") {
        try {
          const body = (await request.json()) as { messages: CloudflareMessage[] };

          // Create agent instance (implementation depends on Durable Objects setup)
          // const id = env.AGENT_DO.idFromName('agent-1');
          // const stub = env.AGENT_DO.get(id);
          // const agent = await stub.fetch(request);

          // For now, show the structure:
          const responseText = JSON.stringify({
            error: "Agent instance creation requires Durable Objects setup",
            hint: "See examples/agents-sdk-example.ts for full implementation",
          });

          return new Response(responseText, {
            status: 501,
            headers: { "Content-Type": "application/json" },
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      return new Response("Method not allowed", { status: 405 });
    },
  };
}
