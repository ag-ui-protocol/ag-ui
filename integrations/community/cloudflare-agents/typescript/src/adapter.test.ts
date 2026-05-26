import { describe, it, expect } from "vitest";
import { AgentsToAGUIAdapter } from "./adapter";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Message } from "@ag-ui/client";

async function collectEvents(gen: AsyncGenerator<BaseEvent>): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeMockStream(options: {
  textChunks?: string[];
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
  toolResults?: Array<{ toolCallId: string; result: unknown }>;
}) {
  const { textChunks = [], toolCalls = [], toolResults = [] } = options;
  async function* fullStreamGen() {
    for (const c of textChunks) yield { type: "text-delta" as const, text: c };
    for (const tc of toolCalls) yield { type: "tool-call" as const, toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.args };
    for (const tr of toolResults) yield { type: "tool-result" as const, toolCallId: tr.toolCallId, output: tr.result };
    yield { type: "finish" as const, finishReason: "stop" };
  }
  return { fullStream: fullStreamGen(), text: Promise.resolve(textChunks.join("")), toolCalls: Promise.resolve(toolCalls), toolResults: Promise.resolve(toolResults) };
}

describe("AgentsToAGUIAdapter", () => {
  const adapter = new AgentsToAGUIAdapter();
  const msgs: Message[] = [{ id: "m1", role: "user", content: "Hello" }];

  it("RUN_STARTED includes forwardedProps", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Hi"] }) as any, "t1", "r1", msgs, undefined, undefined, { temp: 0.5 }));
    const rs = events.find((e) => e.type === EventType.RUN_STARTED) as any;
    expect(rs.input.forwardedProps).toEqual({ temp: 0.5 });
  });

  it("uses TEXT_MESSAGE_START/CONTENT/END — not CHUNK", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Hi ", "there"] }) as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CHUNK);
  });

  it("uses TOOL_CALL_START/ARGS/END — not CHUNK", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ toolCalls: [{ toolCallId: "tc1", toolName: "search", args: { q: "x" } }] }) as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).not.toContain(EventType.TOOL_CALL_CHUNK);
  });

  it("handles true interleaving: text → tool → text via fullStream", async () => {
    async function* interleaved() {
      yield { type: "text-delta" as const, text: "Let me " };
      yield { type: "text-delta" as const, text: "search" };
      yield { type: "tool-call" as const, toolCallId: "tc1", toolName: "search", input: { q: "x" } };
      yield { type: "text-delta" as const, text: " done" };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: interleaved(), text: Promise.resolve("Let me search done"), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);
    const firstTextEnd = types.indexOf(EventType.TEXT_MESSAGE_END);
    const toolStart = types.indexOf(EventType.TOOL_CALL_START);
    expect(firstTextEnd).toBeLessThan(toolStart);
    expect(firstTextEnd).toBeGreaterThan(0);

    // Each text segment must have a unique messageId (protocol requires unique lifecycle IDs)
    const textStarts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START) as any[];
    expect(textStarts).toHaveLength(2);
    expect(textStarts[0].messageId).not.toBe(textStarts[1].messageId);
  });

  it("emits TOOL_CALL_RESULT", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ toolCalls: [{ toolCallId: "tc1", toolName: "s", args: {} }], toolResults: [{ toolCallId: "tc1", result: { a: 1 } }] }) as any, "t1", "r1", msgs));
    const r = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as any;
    expect(r.toolCallId).toBe("tc1");
    expect(r.content).toBe(JSON.stringify({ a: 1 }));
  });

  it("uses UUID format IDs", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Hi"] }) as any));
    const rs = events.find((e) => e.type === EventType.RUN_STARTED) as any;
    expect(rs.threadId).toMatch(/^[0-9a-f]{8}-/i);
    expect(rs.runId).toMatch(/^[0-9a-f]{8}-/i);
  });

  it("RUN_FINISHED includes outcome: success", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Done"] }) as any, "t1", "r1", msgs));
    expect((events.find((e) => e.type === EventType.RUN_FINISHED) as any).outcome).toEqual({ type: "success" });
  });

  it("does not import nanoid", async () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "adapter.ts"), "utf-8");
    expect(src).not.toContain("nanoid");
  });

  it("emits MESSAGES_SNAPSHOT with assistant message", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Hello world"] }) as any, "t1", "r1", msgs));
    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    expect(snap.messages).toHaveLength(2);
    expect(snap.messages[1].role).toBe("assistant");
  });

  it("MESSAGES_SNAPSHOT includes tool calls and tool results", async () => {
    const events = await collectEvents(
      adapter.adaptStreamToAGUI(
        makeMockStream({
          textChunks: ["Searching..."],
          toolCalls: [{ toolCallId: "tc1", toolName: "search", args: { q: "x" } }],
          toolResults: [{ toolCallId: "tc1", result: { found: true } }],
        }) as any,
        "t1",
        "r1",
        msgs,
      ),
    );
    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    // Should have: input message + assistant message + tool message
    expect(snap.messages).toHaveLength(3);
    // Assistant message should have toolCalls
    const assistant = snap.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0]).toEqual({
      id: "tc1",
      type: "function",
      function: { name: "search", arguments: JSON.stringify({ q: "x" }) },
    });
    // Tool message
    const toolMsg = snap.messages[2];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.toolCallId).toBe("tc1");
    expect(toolMsg.content).toBe(JSON.stringify({ found: true }));
    // The tool message ID in the snapshot must match the messageId from the TOOL_CALL_RESULT event
    const toolResultEvent = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as any;
    expect(toolMsg.id).toBe(toolResultEvent.messageId);
  });

  it("emits RUN_ERROR on stream failure", async () => {
    async function* fail() { yield { type: "text-delta" as const, text: "x" }; throw new Error("broke"); }
    const events = await collectEvents(adapter.adaptStreamToAGUI({ fullStream: fail(), text: Promise.resolve(""), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) } as any, "t1", "r1"));
    expect((events.find((e) => e.type === EventType.RUN_ERROR) as any).message).toContain("broke");
  });

  it("emits TEXT_MESSAGE_END before RUN_ERROR on mid-message failure", async () => {
    async function* fail() { yield { type: "text-delta" as const, text: "partial" }; throw new Error("mid"); }
    const events = await collectEvents(adapter.adaptStreamToAGUI({ fullStream: fail(), text: Promise.resolve(""), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) } as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(types.indexOf(EventType.RUN_ERROR));
  });

  it("emits TOOL_CALL_RESULT with error content on tool-error", async () => {
    async function* toolErrorStream() {
      yield { type: "tool-call" as const, toolCallId: "tc1", toolName: "failingTool", input: { x: 1 } };
      yield { type: "tool-error" as const, toolCallId: "tc1", toolName: "failingTool", error: new Error("tool exploded") };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: toolErrorStream(), text: Promise.resolve(""), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const r = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as any;
    expect(r).toBeDefined();
    expect(r.toolCallId).toBe("tc1");
    expect(r.role).toBe("tool");
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("tool exploded");
    // MESSAGES_SNAPSHOT must include the tool error message
    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    expect(snap).toBeDefined();
    const toolMsg = snap.messages.find((m: any) => m.role === "tool" && m.toolCallId === "tc1");
    expect(toolMsg).toBeDefined();
    expect(JSON.parse(toolMsg.content).error).toBe("tool exploded");
    // The tool message ID must match the TOOL_CALL_RESULT event messageId
    expect(toolMsg.id).toBe(r.messageId);
  });

  it("emits STATE_SNAPSHOT when state provided", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Hi"] }) as any, "t1", "r1", msgs, undefined, { count: 5 }));
    expect((events.find((e) => e.type === EventType.STATE_SNAPSHOT) as any).snapshot).toEqual({ count: 5 });
  });

  it("does NOT emit STATE_SNAPSHOT when state empty", async () => {
    const events = await collectEvents(adapter.adaptStreamToAGUI(makeMockStream({ textChunks: ["Hi"] }) as any, "t1", "r1", msgs, undefined, {}));
    expect(events.find((e) => e.type === EventType.STATE_SNAPSHOT)).toBeUndefined();
  });

  it("emits REASONING_START/MESSAGE_START/MESSAGE_CONTENT/MESSAGE_END/END for reasoning-delta", async () => {
    async function* reasoningStream() {
      yield { type: "reasoning-start" as const, id: "r1" };
      yield { type: "reasoning-delta" as const, id: "r1", text: "Let me think" };
      yield { type: "reasoning-delta" as const, id: "r1", text: " about this" };
      yield { type: "reasoning-end" as const, id: "r1" };
      yield { type: "text-delta" as const, text: "Answer" };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: reasoningStream(), text: Promise.resolve("Answer"), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);

    // Verify order: START -> MSG_START -> MSG_CONTENT(s) -> MSG_END -> END
    const rStart = types.indexOf(EventType.REASONING_START);
    const rMsgStart = types.indexOf(EventType.REASONING_MESSAGE_START);
    const rMsgContent = types.indexOf(EventType.REASONING_MESSAGE_CONTENT);
    const rMsgEnd = types.indexOf(EventType.REASONING_MESSAGE_END);
    const rEnd = types.indexOf(EventType.REASONING_END);
    expect(rStart).toBeLessThan(rMsgStart);
    expect(rMsgStart).toBeLessThan(rMsgContent);
    expect(rMsgContent).toBeLessThan(rMsgEnd);
    expect(rMsgEnd).toBeLessThan(rEnd);

    // All reasoning events share the same messageId
    const reasoningEvents = events.filter((e) =>
      [EventType.REASONING_START, EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END, EventType.REASONING_END].includes(e.type as EventType),
    ) as any[];
    const reasoningMsgId = reasoningEvents[0].messageId;
    expect(reasoningMsgId).toBeTruthy();
    for (const re of reasoningEvents) {
      expect(re.messageId).toBe(reasoningMsgId);
    }

    // Two content deltas
    const contentEvents = events.filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT) as any[];
    expect(contentEvents).toHaveLength(2);
    expect(contentEvents[0].delta).toBe("Let me think");
    expect(contentEvents[1].delta).toBe(" about this");
  });

  it("closes dangling reasoning on normal stream completion", async () => {
    async function* reasoningNoEnd() {
      yield { type: "reasoning-start" as const, id: "r1", providerMetadata: undefined };
      yield { type: "reasoning-delta" as const, id: "r1", text: "thinking..." };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: reasoningNoEnd(), text: Promise.resolve(""), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);
    expect(types.indexOf(EventType.REASONING_END)).toBeLessThan(types.indexOf(EventType.MESSAGES_SNAPSHOT));
  });

  it("closes dangling reasoning on stream error", async () => {
    async function* reasoningThenError() {
      yield { type: "reasoning-start" as const, id: "r1", providerMetadata: undefined };
      yield { type: "reasoning-delta" as const, id: "r1", text: "thinking..." };
      throw new Error("stream broke");
    }
    const stream = { fullStream: reasoningThenError(), text: Promise.resolve(""), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);
    const reasoningEndIdx = types.indexOf(EventType.REASONING_END);
    const runErrorIdx = types.indexOf(EventType.RUN_ERROR);
    expect(reasoningEndIdx).toBeLessThan(runErrorIdx);
  });

  it("emits STEP_STARTED/STEP_FINISHED for multi-step streams", async () => {
    async function* steppedStream() {
      yield { type: "start-step" as const };
      yield { type: "text-delta" as const, text: "Step 1 " };
      yield { type: "finish-step" as const };
      yield { type: "start-step" as const };
      yield { type: "text-delta" as const, text: "Step 2" };
      yield { type: "finish-step" as const };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: steppedStream(), text: Promise.resolve("Step 1 Step 2"), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));

    const stepStarted = events.filter((e) => e.type === EventType.STEP_STARTED) as any[];
    const stepFinished = events.filter((e) => e.type === EventType.STEP_FINISHED) as any[];
    expect(stepStarted).toHaveLength(2);
    expect(stepFinished).toHaveLength(2);

    // Step names increment
    expect(stepStarted[0].stepName).toBe("step-1");
    expect(stepStarted[1].stepName).toBe("step-2");
    expect(stepFinished[0].stepName).toBe("step-1");
    expect(stepFinished[1].stepName).toBe("step-2");
  });

  it("streams tool args incrementally via tool-input-*", async () => {
    async function* toolInputStream() {
      yield { type: "text-delta" as const, text: "Calling tool" };
      yield { type: "tool-input-start" as const, id: "tc1", toolName: "search" };
      yield { type: "tool-input-delta" as const, id: "tc1", delta: '{"q":' };
      yield { type: "tool-input-delta" as const, id: "tc1", delta: '"hello"}' };
      yield { type: "tool-input-end" as const, id: "tc1" };
      yield { type: "tool-call" as const, toolCallId: "tc1", toolName: "search", input: { q: "hello" } };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: toolInputStream(), text: Promise.resolve("Calling tool"), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);

    // Should have TOOL_CALL_START from tool-input-start
    const toolStarts = events.filter((e) => e.type === EventType.TOOL_CALL_START) as any[];
    expect(toolStarts).toHaveLength(1); // NOT duplicated by tool-call

    // Two TOOL_CALL_ARGS from the two deltas
    const toolArgs = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS) as any[];
    expect(toolArgs).toHaveLength(2);
    expect(toolArgs[0].delta).toBe('{"q":');
    expect(toolArgs[1].delta).toBe('"hello"}');

    // TOOL_CALL_END emitted once
    const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END) as any[];
    expect(toolEnds).toHaveLength(1);

    // TEXT_MESSAGE_END should come before TOOL_CALL_START (text closed before tool streaming)
    const textEndIdx = types.indexOf(EventType.TEXT_MESSAGE_END);
    const toolStartIdx = types.indexOf(EventType.TOOL_CALL_START);
    expect(textEndIdx).toBeLessThan(toolStartIdx);

    // MESSAGES_SNAPSHOT should still include the tool call
    const snap = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    const assistantMsg = snap.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.toolCalls).toHaveLength(1);
    expect(assistantMsg.toolCalls[0].id).toBe("tc1");
  });

  it("emits RAW events for raw parts", async () => {
    async function* rawStream() {
      yield { type: "text-delta" as const, text: "Hi" };
      yield { type: "raw" as const, rawValue: { model: "gpt-4", tokens: 42 } };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: rawStream(), text: Promise.resolve("Hi"), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const rawEvent = events.find((e) => e.type === EventType.RAW) as any;
    expect(rawEvent).toBeDefined();
    expect(rawEvent.event).toEqual({ model: "gpt-4", tokens: 42 });
    expect(rawEvent.source).toBe("ai-sdk");
  });

  it("emits RUN_ERROR on in-band error part", async () => {
    async function* errorPartStream() {
      yield { type: "text-delta" as const, text: "Hello " };
      yield { type: "text-delta" as const, text: "world" };
      yield { type: "error" as const, error: new Error("in-band failure") };
      // These should never be reached
      yield { type: "text-delta" as const, text: " after error" };
      yield { type: "finish" as const, finishReason: "stop" };
    }
    const stream = { fullStream: errorPartStream(), text: Promise.resolve(""), toolCalls: Promise.resolve([]), toolResults: Promise.resolve([]) };
    const events = await collectEvents(adapter.adaptStreamToAGUI(stream as any, "t1", "r1", msgs));
    const types = events.map((e) => e.type);

    // TEXT_MESSAGE_END must appear before RUN_ERROR (close the open message)
    const textEndIdx = types.indexOf(EventType.TEXT_MESSAGE_END);
    const runErrorIdx = types.indexOf(EventType.RUN_ERROR);
    expect(textEndIdx).toBeGreaterThan(-1);
    expect(runErrorIdx).toBeGreaterThan(textEndIdx);

    // RUN_ERROR has the right message and code
    const errEvent = events.find((e) => e.type === EventType.RUN_ERROR) as any;
    expect(errEvent.message).toBe("in-band failure");
    expect(errEvent.code).toBe("STREAM_ERROR");

    // No RUN_FINISHED should be emitted
    expect(types).not.toContain(EventType.RUN_FINISHED);

    // No events after RUN_ERROR
    expect(runErrorIdx).toBe(events.length - 1);
  });
});
