// src/index.ts
import { AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
var CloudflareAgentsAgent = class extends AbstractAgent {
  constructor(config) {
    super(config);
    this.ws = null;
    this.abortController = new AbortController();
    this.url = config.url;
  }
  runAgent(parameters, subscriber) {
    var _a;
    this.abortController = (_a = parameters == null ? void 0 : parameters.abortController) != null ? _a : new AbortController();
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
  run(input) {
    return new Observable((observer) => {
      const wsUrl = this.url.replace(/^http/, "ws");
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        var _a, _b;
        const message = (_a = input.messages) == null ? void 0 : _a[0];
        if (message && "content" in message && typeof message.content === "string") {
          (_b = this.ws) == null ? void 0 : _b.send(message.content);
        }
      };
      this.ws.onmessage = (event) => {
        try {
          const cloudflareEvent = JSON.parse(event.data);
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
  transformEvent(cloudflareEvent) {
    switch (cloudflareEvent.type) {
      case "RUN_STARTED":
        return {
          type: EventType.RUN_STARTED,
          run_id: cloudflareEvent.run_id,
          thread_id: cloudflareEvent.thread_id
        };
      case "TEXT_MESSAGE_START":
        return {
          type: EventType.TEXT_MESSAGE_START,
          run_id: cloudflareEvent.run_id,
          role: cloudflareEvent.role
        };
      case "TEXT_MESSAGE_CONTENT":
        return {
          type: EventType.TEXT_MESSAGE_CONTENT,
          run_id: cloudflareEvent.run_id,
          delta: cloudflareEvent.delta
        };
      case "TEXT_MESSAGE_END":
        return {
          type: EventType.TEXT_MESSAGE_END,
          run_id: cloudflareEvent.run_id
        };
      case "RUN_FINISHED":
        return {
          type: EventType.RUN_FINISHED,
          run_id: cloudflareEvent.run_id
        };
      case "READY":
        return null;
      default:
        console.warn("Unknown Cloudflare Agent event type:", cloudflareEvent.type);
        return null;
    }
  }
  clone() {
    const cloned = super.clone();
    cloned.url = this.url;
    const newController = new AbortController();
    const originalSignal = this.abortController.signal;
    if (originalSignal.aborted) {
      newController.abort(originalSignal.reason);
    }
    cloned.abortController = newController;
    return cloned;
  }
};
export {
  CloudflareAgentsAgent
};
//# sourceMappingURL=index.mjs.map