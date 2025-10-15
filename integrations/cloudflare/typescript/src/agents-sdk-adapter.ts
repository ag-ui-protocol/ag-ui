/**
 * Cloudflare Agents SDK Integration for AG-UI
 *
 * Bridges the Cloudflare Agents SDK with AG-UI protocol, enabling
 * stateful agents with built-in SQL, state management, and scheduling
 * to work seamlessly with CopilotKit and other AG-UI frontends.
 */

import { CloudflareAGUIEvents, AGUIEvent } from "./events";
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
  transformEvent?: (event: any) => AGUIEvent | null;
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
export class CloudflareAgentsSDKAdapter {
  private agent: CloudflareAgentsSDKAgent;
  private options: AgentsSDKAdapterOptions;
  private runCounter = 0;
  private stateListeners: Set<(state: any) => void> = new Set();

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
  ): AsyncGenerator<AGUIEvent> {
    const runId = this.generateRunId();

    try {
      // Emit run started
      yield CloudflareAGUIEvents.runStarted(runId, {
        agentId: this.agent.id,
        messageCount: messages.length,
        ...context,
      });

      // Get initial state
      if (this.options.syncState) {
        const initialState = this.agent.getState();
        yield CloudflareAGUIEvents.stateSync(runId, initialState);
      }

      // Check if agent has onChatMessage (AIChatAgent)
      if (typeof (this.agent as any).onChatMessage === "function") {
        yield* this.handleChatAgent(runId, messages, context);
      } else {
        // Handle as generic agent
        yield* this.handleGenericAgent(runId, messages, context);
      }

      // Emit final state if changed
      if (this.options.syncState) {
        const finalState = this.agent.getState();
        yield CloudflareAGUIEvents.stateSync(runId, finalState);
      }

      // Emit run finished
      yield CloudflareAGUIEvents.runFinished(runId);
    } catch (error) {
      yield CloudflareAGUIEvents.error(runId, error as Error);
      throw error;
    }
  }

  /**
   * Handle AIChatAgent (has onChatMessage method)
   */
  private async *handleChatAgent(
    runId: string,
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<AGUIEvent> {
    const lastMessage = messages[messages.length - 1];

    if (!lastMessage || lastMessage.role !== "user") {
      throw new Error("Last message must be from user");
    }

    // Start text message
    yield CloudflareAGUIEvents.textMessageStart(runId, "assistant");

    // Stream from agent's onChatMessage
    const agent = this.agent as any;
    const stream = agent.onChatMessage(lastMessage.content, {
      messages,
      ...context,
    });

    for await (const chunk of stream) {
      // Emit text content
      yield CloudflareAGUIEvents.textMessageContent(runId, chunk);

      // Check for state changes
      if (this.options.syncState) {
        const currentState = this.agent.getState();
        yield CloudflareAGUIEvents.stateSync(runId, currentState);
      }
    }

    // End text message
    yield CloudflareAGUIEvents.textMessageEnd(runId);
  }

  /**
   * Handle generic Agent (manual message processing)
   */
  private async *handleGenericAgent(
    runId: string,
    messages: CloudflareMessage[],
    context?: Record<string, any>,
  ): AsyncGenerator<AGUIEvent> {
    // For generic agents, we need to manually process
    // This would typically involve calling agent methods

    yield CloudflareAGUIEvents.textMessageStart(runId, "assistant");

    const response = await this.processMessages(messages, context);

    yield CloudflareAGUIEvents.textMessageContent(runId, response);
    yield CloudflareAGUIEvents.textMessageEnd(runId);
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
   * Execute SQL query and emit as metadata event
   */
  async executeSQLWithTracking(query: TemplateStringsArray, ...values: any[]): Promise<any[]> {
    if (!this.options.trackSQL) {
      return this.agent.sql(query, ...values);
    }

    const startTime = Date.now();
    const result = await this.agent.sql(query, ...values);
    const duration = Date.now() - startTime;

    // Could emit metadata event here if needed
    console.log(`SQL executed in ${duration}ms:`, query.join("?"), values);

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
