/**
 * Client-side Cloudflare Agents integration
 *
 * WebSocket-based client that connects to deployed Cloudflare Agents
 * and translates their events into AG-UI protocol events.
 */

import {
  AbstractAgent,
  AgentConfig,
  randomUUID,
  EventType,
  type RunAgentInput,
  type BaseEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageChunkEvent,
  type StateSnapshotEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";

export interface CloudflareAgentsClientConfig extends AgentConfig {
  /** WebSocket URL to deployed Cloudflare Agent */
  url: string;
}

/**
 * AG-UI client for connecting to deployed Cloudflare Agents
 *
 * Extends AbstractAgent and provides WebSocket connection to Cloudflare Workers
 * running the Cloudflare Agents SDK.
 *
 * @example
 * ```ts
 * const agent = new CloudflareAgentsClient({
 *   url: "wss://your-worker.workers.dev"
 * });
 *
 * agent.runAgent({
 *   messages: [{ role: "user", content: "Hello!" }]
 * }).subscribe({
 *   next: (event) => console.log(event.type, event),
 *   error: (err) => console.error(err),
 *   complete: () => console.log("Done")
 * });
 * ```
 */
export class CloudflareAgentsClient extends AbstractAgent {
  private url: string;
  private ws: any = null;
  private currentMessageId: string | null = null;

  constructor(config: CloudflareAgentsClientConfig) {
    super(config);
    this.url = config.url;
  }

  /**
   * Connect to Cloudflare Agent and stream AG-UI events
   *
   * @param input - Run configuration including messages, threadId, runId
   * @returns Observable stream of AG-UI events
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const wsUrl = this.url
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:");

      const onOpen = () => {
        this.ws?.send(
          JSON.stringify({
            type: "INIT",
            messages: input.messages,
            threadId: input.threadId,
            runId: input.runId,
          })
        );
      };

      const onMessage = (event: any) => {
        try {
          const data =
            typeof event.data === "string" ? event.data : event.data.toString();
          const cfEvent = JSON.parse(data);

          const aguiEvent = this.transformEvent(cfEvent);
          if (aguiEvent) {
            subscriber.next(aguiEvent);
          }
        } catch (err) {
          console.error("Failed to parse message:", err);
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: `Failed to parse server message: ${err instanceof Error ? err.message : "Unknown error"}`,
            code: "PARSE_ERROR",
            timestamp: Date.now(),
          } as RunErrorEvent);
        }
      };

      const onError = (error: any) => {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: "WebSocket connection error",
          code: "WS_ERROR",
          timestamp: Date.now(),
        } as RunErrorEvent);
        subscriber.error(error);
      };

      const onClose = () => {
        this.currentMessageId = null;
        const runFinishedEvent: RunFinishedEvent = {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
          timestamp: Date.now(),
        };
        subscriber.next(runFinishedEvent);
        subscriber.complete();
      };

      try {
        const WebSocketConstructor =
          typeof WebSocket !== "undefined" ? WebSocket : null;

        if (!WebSocketConstructor) {
          throw new Error(
            "WebSocket not available. In Node.js, install the 'ws' package."
          );
        }

        this.ws = new WebSocketConstructor(wsUrl);

        const runStartedEvent: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
          timestamp: Date.now(),
          ...(input.parentRunId && { parentRunId: input.parentRunId }),
          input: {
            threadId: input.threadId,
            runId: input.runId,
            messages: input.messages,
            state: input.state || {},
            tools: input.tools || [],
            context: input.context || [],
            ...(input.parentRunId && { parentRunId: input.parentRunId }),
          },
        };
        subscriber.next(runStartedEvent);

        if (this.ws.addEventListener) {
          this.ws.addEventListener("open", onOpen);
          this.ws.addEventListener("message", onMessage);
          this.ws.addEventListener("error", onError);
          this.ws.addEventListener("close", onClose);
        } else {
          this.ws.on("open", onOpen);
          this.ws.on("message", onMessage);
          this.ws.on("error", onError);
          this.ws.on("close", onClose);
        }
      } catch (error) {
        subscriber.error(error);
      }

      return () => {
        if (this.ws) {
          if (this.ws.removeEventListener) {
            this.ws.removeEventListener("open", onOpen);
            this.ws.removeEventListener("message", onMessage);
            this.ws.removeEventListener("error", onError);
            this.ws.removeEventListener("close", onClose);
          } else if (this.ws.off) {
            this.ws.off("open", onOpen);
            this.ws.off("message", onMessage);
            this.ws.off("error", onError);
            this.ws.off("close", onClose);
          }
          this.ws.close();
          this.ws = null;
        }
        this.currentMessageId = null;
      };
    });
  }

  /**
   * Transform Cloudflare Agent event to AG-UI protocol event
   *
   * Maps Cloudflare SDK events to AG-UI events:
   * - TEXT_CHUNK → TEXT_MESSAGE_CHUNK
   * - cf_agent_state → STATE_SNAPSHOT
   * - READY, PONG → ignored
   */
  private transformEvent(cfEvent: any): BaseEvent | null {
    switch (cfEvent.type) {
      case "TEXT_CHUNK": {
        const incomingMessageId = cfEvent.messageId;

        if (incomingMessageId) {
          this.currentMessageId = incomingMessageId;
        } else if (!this.currentMessageId) {
          this.currentMessageId = randomUUID();
        }

        return {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: this.currentMessageId,
          role: "assistant",
          delta: cfEvent.text,
          timestamp: Date.now(),
        } as TextMessageChunkEvent;
      }

      case "cf_agent_state": {
        return {
          type: EventType.STATE_SNAPSHOT,
          state: cfEvent.state || {},
          timestamp: Date.now(),
        } as StateSnapshotEvent;
      }

      case "READY":
      case "PONG":
        return null;

      default:
        console.warn("Unknown Cloudflare event:", cfEvent.type);
        return null;
    }
  }

  /**
   * Abort the current agent run
   */
  override abortRun() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.currentMessageId = null;
    super.abortRun();
  }

  /**
   * Clone this agent instance
   */
  override clone(): CloudflareAgentsClient {
    return new CloudflareAgentsClient({
      agentId: this.agentId,
      description: this.description,
      threadId: this.threadId,
      initialMessages: this.messages,
      initialState: this.state,
      debug: this.debug,
      url: this.url,
    });
  }
}
