import { AbstractAgent, RunAgentResult } from "@ag-ui/client";
import { AgentConfig, RunAgentParameters } from "@ag-ui/client";
import { RunAgentInput, BaseEvent, EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import { AgentSubscriber } from "@ag-ui/client";

interface CloudflareAgentsConfig extends AgentConfig {
  url: string;
}

interface RunCloudflareAgentConfig extends RunAgentParameters {
  abortController?: AbortController;
}

/**
 * Cloudflare Agents AG-UI connector
 * Connects to a Cloudflare Worker running the Agents SDK via WebSocket
 */
export class CloudflareAgentsAgent extends AbstractAgent {
  public url: string;
  private ws: WebSocket | null = null;
  public abortController: AbortController = new AbortController();

  constructor(config: CloudflareAgentsConfig) {
    super(config);
    this.url = config.url;
  }

  public runAgent(
    parameters?: RunCloudflareAgentConfig,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.abortController = parameters?.abortController ?? new AbortController();
    return super.runAgent(parameters, subscriber);
  }

  abortRun() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.abortController.abort();
    super.abortRun();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      const wsUrl = this.url.replace(/^http/, "ws");
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        // Send the AG-UI input to the Cloudflare Agent
        const message = input.messages?.[0];
        if (message && "content" in message && typeof message.content === "string") {
          this.ws?.send(message.content);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const cloudflareEvent = JSON.parse(event.data);

          // Transform Cloudflare Agent events to AG-UI events
          const agEvent = this.transformEvent(cloudflareEvent);
          if (agEvent) {
            observer.next(agEvent);
          }
        } catch (err) {
          observer.error(err);
        }
      };

      this.ws.onerror = (error) => {
        observer.error(error);
      };

      this.ws.onclose = () => {
        observer.complete();
      };

      return () => {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
      };
    });
  }

  private transformEvent(cloudflareEvent: any): BaseEvent | null {
    // Map Cloudflare Agent events to AG-UI events
    switch (cloudflareEvent.type) {
      case "RUN_STARTED":
        return {
          type: EventType.RUN_STARTED,
          run_id: cloudflareEvent.run_id,
          thread_id: cloudflareEvent.thread_id,
        };

      case "TEXT_MESSAGE_START":
        return {
          type: EventType.TEXT_MESSAGE_START,
          run_id: cloudflareEvent.run_id,
          role: cloudflareEvent.role,
        };

      case "TEXT_MESSAGE_CONTENT":
        return {
          type: EventType.TEXT_MESSAGE_CONTENT,
          run_id: cloudflareEvent.run_id,
          delta: cloudflareEvent.delta,
        };

      case "TEXT_MESSAGE_END":
        return {
          type: EventType.TEXT_MESSAGE_END,
          run_id: cloudflareEvent.run_id,
        };

      case "RUN_FINISHED":
        return {
          type: EventType.RUN_FINISHED,
          run_id: cloudflareEvent.run_id,
        };

      case "READY":
        // Ignore handshake events
        return null;

      default:
        console.warn("Unknown Cloudflare Agent event type:", cloudflareEvent.type);
        return null;
    }
  }

  public clone(): CloudflareAgentsAgent {
    const cloned = super.clone() as CloudflareAgentsAgent;
    cloned.url = this.url;

    const newController = new AbortController();
    const originalSignal = this.abortController.signal as AbortSignal & { reason?: unknown };
    if (originalSignal.aborted) {
      newController.abort(originalSignal.reason);
    }
    cloned.abortController = newController;

    return cloned;
  }
}
