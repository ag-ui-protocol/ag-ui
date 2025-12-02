"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CloudflareAgentsAgent: () => CloudflareAgentsAgent
});
module.exports = __toCommonJS(index_exports);
var import_client = require("@ag-ui/client");
var import_core = require("@ag-ui/core");
var import_rxjs = require("rxjs");
var CloudflareAgentsAgent = class extends import_client.AbstractAgent {
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
    return new import_rxjs.Observable((observer) => {
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
          type: import_core.EventType.RUN_STARTED,
          run_id: cloudflareEvent.run_id,
          thread_id: cloudflareEvent.thread_id
        };
      case "TEXT_MESSAGE_START":
        return {
          type: import_core.EventType.TEXT_MESSAGE_START,
          run_id: cloudflareEvent.run_id,
          role: cloudflareEvent.role
        };
      case "TEXT_MESSAGE_CONTENT":
        return {
          type: import_core.EventType.TEXT_MESSAGE_CONTENT,
          run_id: cloudflareEvent.run_id,
          delta: cloudflareEvent.delta
        };
      case "TEXT_MESSAGE_END":
        return {
          type: import_core.EventType.TEXT_MESSAGE_END,
          run_id: cloudflareEvent.run_id
        };
      case "RUN_FINISHED":
        return {
          type: import_core.EventType.RUN_FINISHED,
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CloudflareAgentsAgent
});
//# sourceMappingURL=index.js.map