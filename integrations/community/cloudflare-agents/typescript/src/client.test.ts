import { describe, it, expect, vi, beforeEach } from "vitest";
import { CloudflareAgentsClient } from "./client";
import { EventType } from "@ag-ui/client";
import type { RunAgentInput, BaseEvent } from "@ag-ui/client";

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "Hello" }],
    state: { counter: 0 },
    tools: [{ name: "search", description: "Search the web", parameters: {} }],
    context: [{ description: "test context", value: "ctx-1" }],
    forwardedProps: { temperature: 0.7 },
    ...overrides,
  };
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  url: string;
  private listeners: Record<string, Function[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: Function) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: Function) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((h) => h !== handler);
    }
  }

  send(data: string) { this.sent.push(data); }

  close() { this.readyState = 3; }

  simulateOpen() {
    this.readyState = 1;
    this.listeners["open"]?.forEach((h) => h());
  }

  simulateMessage(data: any) {
    this.listeners["message"]?.forEach((h) => h({ data: JSON.stringify(data) }));
  }

  simulateRawMessage(data: string) {
    this.listeners["message"]?.forEach((h) => h({ data }));
  }

  simulateError(error: Error) {
    this.listeners["error"]?.forEach((h) => h(error));
  }

  simulateClose() {
    this.listeners["close"]?.forEach((h) => h());
  }
}

describe("CloudflareAgentsClient", () => {
  let client: CloudflareAgentsClient;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    client = new CloudflareAgentsClient({ url: "wss://test.workers.dev" });
  });

  it("emits RUN_STARTED only after WebSocket connects", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    expect(events.length).toBe(0);
    MockWebSocket.instances[0].simulateOpen();
    expect(events.find((e) => e.type === EventType.RUN_STARTED)).toBeDefined();
  });

  it("RUN_STARTED includes forwardedProps in input", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    MockWebSocket.instances[0].simulateOpen();
    const rs = events.find((e) => e.type === EventType.RUN_STARTED) as any;
    expect(rs.input.forwardedProps).toEqual({ temperature: 0.7 });
    expect(rs.input.state).toEqual({ counter: 0 });
    expect(rs.input.tools).toHaveLength(1);
    expect(rs.input.context).toHaveLength(1);
  });

  it("sends full RunAgentInput in INIT message", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    const init = JSON.parse(ws.sent[0]);
    expect(init.type).toBe("INIT");
    expect(init.state).toEqual({ counter: 0 });
    expect(init.tools).toHaveLength(1);
    expect(init.context).toHaveLength(1);
    expect(init.forwardedProps).toEqual({ temperature: 0.7 });
  });

  it("STATE_SNAPSHOT uses 'snapshot' field, not 'state'", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "cf_agent_state", state: { count: 42 } });
    const snap = events.find((e) => e.type === EventType.STATE_SNAPSHOT) as any;
    expect(snap.snapshot).toEqual({ count: 42 });
    expect(snap).not.toHaveProperty("state");
  });

  it("emits TEXT_MESSAGE_START/CONTENT/END for text chunks", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "TEXT_CHUNK", text: "Hello " });
    ws.simulateMessage({ type: "TEXT_CHUNK", text: "world" });
    ws.simulateClose();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CHUNK);
  });

  it("emits TOOL_CALL_START/ARGS/END for tool calls", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "TOOL_CALL", toolCallId: "tc-1", toolName: "search", args: '{"q":"test"}' });
    ws.simulateClose();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
  });

  it("does NOT emit RUN_FINISHED after RUN_ERROR", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e), error: () => {} });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateError(new Error("lost"));
    ws.simulateClose();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);
  });

  it("RUN_FINISHED includes outcome: success on clean close", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateClose();
    const fin = events.find((e) => e.type === EventType.RUN_FINISHED) as any;
    expect(fin.outcome).toEqual({ type: "success" });
  });

  it("cleans up WebSocket on unsubscribe", () => {
    const sub = client.run(makeInput()).subscribe({ next: () => {} });
    MockWebSocket.instances[0].simulateOpen();
    sub.unsubscribe();
    expect(MockWebSocket.instances[0].readyState).toBe(3);
  });

  it("abortRun closes the WebSocket", () => {
    client.run(makeInput()).subscribe({ next: () => {}, error: () => {} });
    MockWebSocket.instances[0].simulateOpen();
    client.abortRun();
    expect(MockWebSocket.instances[0].readyState).toBe(3);
  });

  it("abortRun emits TEXT_MESSAGE_END for in-flight message via onClose", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    // Start a text message
    ws.simulateMessage({ type: "TEXT_CHUNK", text: "partial response" });
    // Abort mid-message
    client.abortRun();
    // Simulate the async WebSocket close event (which triggers onClose handler)
    ws.simulateClose();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(types.indexOf(EventType.RUN_FINISHED));
  });

  it("errors when WebSocket is not available", () => {
    vi.stubGlobal("WebSocket", undefined);
    const errors: any[] = [];
    client.run(makeInput()).subscribe({ next: () => {}, error: (e) => errors.push(e) });
    expect(errors[0].message).toContain("WebSocket not available");
  });

  it("emits TEXT_MESSAGE_END before TOOL_CALL_START when text interrupted by tool", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "TEXT_CHUNK", text: "Let me search" });
    ws.simulateMessage({ type: "TOOL_CALL", toolCallId: "tc-1", toolName: "search", args: '{"q":"test"}' });
    ws.simulateClose();
    const types = events.map((e) => e.type);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(types.indexOf(EventType.TOOL_CALL_START));
  });

  it("emits RAW event for unknown CF event types", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "NEW_FEATURE", data: "test" });
    ws.simulateClose();
    const raw = events.find((e) => e.type === EventType.RAW) as any;
    expect(raw).toBeDefined();
    expect(raw.event).toEqual({ type: "NEW_FEATURE", data: "test" });
    expect(raw.source).toBe("cloudflare-agents");
  });

  it("emits CUSTOM event for CUSTOM CF event type", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e) });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "CUSTOM", name: "user-activity", value: { action: "click" } });
    ws.simulateClose();
    const custom = events.find((e) => e.type === EventType.CUSTOM) as any;
    expect(custom).toBeDefined();
    expect(custom.name).toBe("user-activity");
    expect(custom.value).toEqual({ action: "click" });
  });

  it("emits TEXT_MESSAGE_END before RUN_ERROR on parse failure during text", () => {
    const events: BaseEvent[] = [];
    client.run(makeInput()).subscribe({ next: (e) => events.push(e), complete: () => {} });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage({ type: "TEXT_CHUNK", text: "partial" });
    ws.simulateRawMessage("not valid JSON");
    ws.simulateClose();
    const types = events.map((e) => e.type);
    const textEndIdx = types.indexOf(EventType.TEXT_MESSAGE_END);
    const errorIdx = types.indexOf(EventType.RUN_ERROR);
    expect(textEndIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeGreaterThan(-1);
    expect(textEndIdx).toBeLessThan(errorIdx);
  });

  it("emits RUN_ERROR and closes on parse failure — no subsequent RUN_FINISHED", () => {
    const events: BaseEvent[] = [];
    let completed = false;
    client.run(makeInput()).subscribe({
      next: (e) => events.push(e),
      complete: () => { completed = true; },
    });
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    // Send a non-JSON message to trigger parse failure
    ws.simulateRawMessage("this is not valid JSON{{{");
    // The close triggered by the fix will fire onClose
    ws.simulateClose();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);
    expect(completed).toBe(true);
  });
});
