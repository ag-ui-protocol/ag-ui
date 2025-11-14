/**
 * Client-side Cloudflare Agents integration
 *
 * Use this to connect AG-UI clients to deployed Cloudflare Agents
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
} from "@ag-ui/client";
import { Observable } from "rxjs";

/** Configuration for CloudflareAgentsClient */
export interface CloudflareAgentsClientConfig extends AgentConfig {
  /** WebSocket URL to deployed Cloudflare Agent */
  url: string;
}

/**
 * AG-UI client for connecting to deployed Cloudflare Agents
 *
 * This agent extends AbstractAgent and connects to a Cloudflare Worker
 * running AIChatAgent via WebSocket, converting events to AG-UI protocol.
 *
 * @example
 * ```ts
 * const agent = new CloudflareAgentsClient({
 *   url: "wss://your-worker.workers.dev"
 * });
 *
 * await agent.runAgent({
 *   // AG-UI parameters
 * });
 * ```
 */
export class CloudflareAgentsClient extends AbstractAgent {
  private url: string;
  private ws: any = null; // WebSocket type varies by environment

  constructor(config: CloudflareAgentsClientConfig) {
    super(config);
    this.url = config.url;
  }

  /**
   * Connect to Cloudflare Agent and stream AG-UI events
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const wsUrl = this.url.replace(/^http/, "ws");

      try {
        // Use global WebSocket (browser/Node with ws package)
        const WebSocketConstructor = typeof WebSocket !== 'undefined'
          ? WebSocket
          : null;

        if (!WebSocketConstructor) {
          throw new Error(
            "WebSocket not available. In Node.js, install the 'ws' package."
          );
        }

        this.ws = new WebSocketConstructor(wsUrl);

        // Emit RUN_STARTED
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
          timestamp: Date.now(),
        } as RunStartedEvent);

        // Handle connection open
        const onOpen = () => {
          this.ws?.send(JSON.stringify({
            type: "INIT",
            messages: input.messages,
            threadId: input.threadId,
            runId: input.runId,
          }));
        };

        // Handle incoming messages
        const onMessage = (event: any) => {
          try {
            const data = typeof event.data === 'string'
              ? event.data
              : event.data.toString();
            const cfEvent = JSON.parse(data);

            // Transform to AG-UI event
            const aguiEvent = this.transformEvent(cfEvent, input);
            if (aguiEvent) {
              subscriber.next(aguiEvent);
            }
          } catch (err) {
            console.error("Failed to parse message:", err);
          }
        };

        // Handle errors
        const onError = (error: any) => {
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: "WebSocket connection error",
            code: "WS_ERROR",
            timestamp: Date.now(),
          } as RunErrorEvent);
          subscriber.error(error);
        };

        // Handle close
        const onClose = () => {
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            timestamp: Date.now(),
          } as RunFinishedEvent);
          subscriber.complete();
        };

        // Attach event listeners (works for both browser and ws package)
        if (this.ws.addEventListener) {
          this.ws.addEventListener('open', onOpen);
          this.ws.addEventListener('message', onMessage);
          this.ws.addEventListener('error', onError);
          this.ws.addEventListener('close', onClose);
        } else {
          this.ws.on('open', onOpen);
          this.ws.on('message', onMessage);
          this.ws.on('error', onError);
          this.ws.on('close', onClose);
        }

      } catch (error) {
        subscriber.error(error);
      }

      // Cleanup function
      return () => {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
      };
    });
  }

  /**
   * Transform Cloudflare event to AG-UI event
   */
  private transformEvent(cfEvent: any, input: RunAgentInput): BaseEvent | null {
    switch (cfEvent.type) {
      case "TEXT_CHUNK":
        return {
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: cfEvent.messageId || randomUUID(),
          role: "assistant",
          delta: cfEvent.text,
          timestamp: Date.now(),
        } as TextMessageChunkEvent;

      case "READY":
      case "PONG":
        return null;

      default:
        console.warn("Unknown Cloudflare event:", cfEvent.type);
        return null;
    }
  }

  /**
   * Abort the current run
   */
  override abortRun() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    super.abortRun();
  }

  /**
   * Clone this agent
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
