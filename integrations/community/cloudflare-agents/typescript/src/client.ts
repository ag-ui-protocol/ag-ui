/**
 * Clients for AG-UI agents on Cloudflare (`@ag-ui/cloudflare-agents/client`).
 *
 * Runs anywhere (browsers, Node, Workers) and does not import the Agents SDK.
 */
import {
  AbstractAgent,
  EventType,
  HttpAgent,
  enforceOutgoingInput,
  runHttpRequest,
  transformHttpEventStream,
  type AgentConfig,
  type BaseEvent,
  type HttpAgentConfig,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { ABORT_FRAME, EVENT_FRAME, RUN_FRAME, parseFrame, threadUrl } from "./protocol";

export { threadUrl } from "./protocol";

/**
 * An `HttpAgent` for a `withAGUI` agent, routed by thread: each run goes to
 * `<url>/<threadId>`, the path the Agents SDK's `routeAgentRequest` maps to
 * that thread's Durable Object.
 *
 * ```ts
 * new CloudflareAgentsHttpAgent({ url: "https://my-worker.example.workers.dev/agents/assistant" });
 * ```
 */
export class CloudflareAgentsHttpAgent extends HttpAgent {
  constructor(config: HttpAgentConfig) {
    super(config);
  }

  // `HttpAgent.clone()` keeps the prototype, so clones route by thread too.
  run(input: RunAgentInput): Observable<BaseEvent> {
    const url = threadUrl(this.url, input.threadId);
    const events = runHttpRequest(() =>
      this.fetch(
        url,
        this.requestInit(enforceOutgoingInput(input, { maxEntries: this.maxEnforcedEntries })),
      ),
    );
    return transformHttpEventStream(events, this.debugLogger);
  }
}

/** A WebSocket constructor: the global one, or the `ws` package's in older Node. */
export type WebSocketConstructor = new (url: string) => WebSocket;

export interface CloudflareAgentsClientConfig extends AgentConfig {
  /**
   * The agent's base URL, such as `wss://my-worker.example.workers.dev/agents/assistant`.
   * The thread id is appended per run. `http(s)` URLs are switched to `ws(s)`.
   */
  url: string;
  /** Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketConstructor;
}

/**
 * Runs a `withAGUI` agent over its WebSocket: one connection per run, to the
 * thread's Durable Object. The connection closes when the run ends.
 */
export class CloudflareAgentsClient extends AbstractAgent {
  readonly url: string;
  private readonly WebSocketImpl?: WebSocketConstructor;
  private active: { socket: WebSocket; runId: string; aborted: boolean } | null = null;

  constructor(config: CloudflareAgentsClientConfig) {
    super(config);
    this.url = config.url;
    this.WebSocketImpl = config.WebSocket;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const WebSocketImpl = this.WebSocketImpl ?? globalThis.WebSocket;
      if (!WebSocketImpl) {
        subscriber.error(
          new Error("No WebSocket implementation. Pass one as `WebSocket` (the `ws` package in Node)."),
        );
        return;
      }

      const url = threadUrl(this.url.replace(/^http(s?):/, "ws$1:"), input.threadId);
      const socket = new WebSocketImpl(url);
      const active = { socket, runId: input.runId, aborted: false };
      this.active = active;
      let finished = false;

      const finish = () => {
        finished = true;
        if (this.active?.socket === socket) this.active = null;
        socket.close();
      };

      socket.addEventListener("open", () => {
        if (active.aborted) {
          // Aborted while connecting: the run never starts.
          finish();
          subscriber.complete();
          return;
        }
        socket.send(JSON.stringify({ type: RUN_FRAME, input }));
      });

      socket.addEventListener("message", (message: MessageEvent) => {
        const frame = parseFrame(message.data);
        if (!frame || frame.type !== EVENT_FRAME || frame.runId !== input.runId) return;
        const event = frame.event as BaseEvent;
        subscriber.next(event);
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          finish();
          subscriber.complete();
        }
      });

      socket.addEventListener("error", () => {
        if (finished) return;
        finish();
        subscriber.error(new Error(`WebSocket error on ${url}`));
      });

      socket.addEventListener("close", (close: CloseEvent) => {
        if (finished) return;
        finished = true;
        if (this.active?.socket === socket) this.active = null;
        subscriber.error(
          new Error(`WebSocket closed before the run finished (code ${close.code}${close.reason ? `: ${close.reason}` : ""})`),
        );
      });

      return () => {
        if (finished) return;
        // Unsubscribed mid-run: tell the agent, then hang up.
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: ABORT_FRAME, runId: input.runId }));
        }
        finish();
      };
    });
  }

  abortRun(): void {
    const active = this.active;
    if (active) {
      active.aborted = true;
      if (active.socket.readyState === 1) {
        active.socket.send(JSON.stringify({ type: ABORT_FRAME, runId: active.runId }));
      }
    }
    super.abortRun();
  }

  clone(): CloudflareAgentsClient {
    const cloned = super.clone() as CloudflareAgentsClient;
    Object.assign(cloned, { url: this.url, WebSocketImpl: this.WebSocketImpl, active: null });
    return cloned;
  }
}
