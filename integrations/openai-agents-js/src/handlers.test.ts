import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";

import { STATE_MANAGEMENT_TOOL_NAME } from "./config";
import {
  StreamContext,
  handleRawModelStreamEvent,
  handleRunItemStreamEvent,
  handleAgentUpdatedStreamEvent,
  closeOpenBlocks,
  buildMessagesSnapshot,
} from "./handlers";

/**
 * Helper: collect emitted events from a series of handler calls.
 */
function run(handler: (ctx: StreamContext) => any[], ctx = new StreamContext("run-1")) {
  return { events: handler(ctx), ctx };
}

describe("handlers — raw model stream events", () => {
  it("opens a text message and emits CONTENT for output_text_delta", () => {
    const ctx = new StreamContext("run-1");
    const e1 = handleRawModelStreamEvent({ type: "output_text_delta", delta: "Hello" }, ctx);
    expect(e1).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "run-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "run-1", delta: "Hello" },
    ]);
    expect(ctx.messageOpen).toBe(true);
    expect(ctx.currentMessageId).toBe("run-1");

    const e2 = handleRawModelStreamEvent({ type: "output_text_delta", delta: " world" }, ctx);
    expect(e2).toEqual([
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "run-1", delta: " world" },
    ]);
  });

  it("emits TOOL_CALL_ARGS deltas only after the call is open", () => {
    const ctx = new StreamContext("run-1");
    // arg delta before tool_called → buffered, not emitted
    const e1 = handleRawModelStreamEvent(
      { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "call_a", delta: '{"city":' } },
      ctx,
    );
    expect(e1).toEqual([]);
    expect(ctx.toolCallArgs.get("call_a")).toBe('{"city":');

    // open the call
    const e2 = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_a", name: "get_weather", arguments: "" },
    }, ctx);
    expect(e2[0]).toMatchObject({ type: EventType.TOOL_CALL_START, toolCallId: "call_a", toolCallName: "get_weather" });
    // buffered args flushed as one ARGS delta
    expect(e2[1]).toMatchObject({ type: EventType.TOOL_CALL_ARGS, toolCallId: "call_a", delta: '{"city":' });
    expect(e2[2]).toMatchObject({ type: EventType.TOOL_CALL_END, toolCallId: "call_a" });

    // subsequent arg deltas stream through
    const e3 = handleRawModelStreamEvent(
      { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "call_a", delta: '"SF"}' } },
      ctx,
    );
    expect(e3).toEqual([
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_a", delta: '"SF"}' },
    ]);
  });

  it("emits REASONING_MESSAGE_START + CONTENT for reasoning summary deltas", () => {
    const ctx = new StreamContext("run-1");
    const e1 = handleRawModelStreamEvent(
      { type: "model", event: { type: "response.reasoning_summary_text.delta", item_id: "rsn_1", delta: "Thinking" } },
      ctx,
    );
    expect(e1).toEqual([
      { type: EventType.REASONING_MESSAGE_START, messageId: "rsn_1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rsn_1", delta: "Thinking" },
    ]);
    expect(ctx.reasoningOpen).toBe(true);
    expect(ctx.currentReasoningId).toBe("rsn_1");
  });

  it("ignores unknown raw event types", () => {
    const ctx = new StreamContext("run-1");
    expect(handleRawModelStreamEvent({ type: "model", event: { type: "response.refusal.delta" } }, ctx)).toEqual([]);
    expect(handleRawModelStreamEvent({ type: "response_started" }, ctx)).toEqual([]);
    expect(handleRawModelStreamEvent(null, ctx)).toEqual([]);
  });
});

describe("handlers — run item events", () => {
  it("tool_called emits START / ARGS(full) / END when no streamed deltas", () => {
    const ctx = new StreamContext("run-1");
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_b", name: "search", arguments: '{"q":"x"}' },
    }, ctx);
    expect(e).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "call_b", toolCallName: "search" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_b", delta: '{"q":"x"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call_b" },
    ]);
    expect(ctx.openToolCalls.has("call_b")).toBe(true);
  });

  it("tool_called with no args emits START + END only", () => {
    const ctx = new StreamContext("run-1");
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_c", name: "noop", arguments: "" },
    }, ctx);
    expect(e).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "call_c", toolCallName: "noop" },
      { type: EventType.TOOL_CALL_END, toolCallId: "call_c" },
    ]);
  });

  it("tool_output emits TOOL_CALL_RESULT with stringified output", () => {
    const ctx = new StreamContext("run-1");
    handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_d", name: "lookup", arguments: "{}" },
    }, ctx);
    const e = handleRunItemStreamEvent("tool_output", {
      rawItem: { callId: "call_d", name: "lookup" },
      output: { ok: true, count: 3 },
    }, ctx);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "call_d",
      messageId: "call_d",
      role: "tool",
    });
    expect((e[0] as any).content).toBe(JSON.stringify({ ok: true, count: 3 }));
    expect(ctx.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
  });

  it("retains a backend tool call when final assistant text follows its result", () => {
    const ctx = new StreamContext("run-1");
    handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_d", name: "get_weather", arguments: '{"location":"SF"}' },
    }, ctx);
    handleRunItemStreamEvent("tool_output", {
      rawItem: { callId: "call_d" },
      output: "sunny",
    }, ctx);
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "It is sunny." }, ctx);
    ctx.flushPendingAssistant();

    expect(ctx.messages).toMatchObject([
      {
        role: "assistant",
        content: "It is sunny.",
        toolCalls: [{ id: "call_d", function: { name: "get_weather" } }],
      },
      { role: "tool", toolCallId: "call_d", content: "sunny" },
    ]);
  });

  it("tool_output with string output passes it through unchanged", () => {
    const ctx = new StreamContext("run-1");
    const e = handleRunItemStreamEvent("tool_output", {
      rawItem: { callId: "call_e" },
      output: "sunny",
    }, ctx);
    expect((e[0] as any).content).toBe("sunny");
  });

  it("message_output_created closes open text + reasoning blocks", () => {
    const ctx = new StreamContext("run-1");
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "hi" }, ctx);
    handleRawModelStreamEvent(
      { type: "model", event: { type: "response.reasoning_summary_text.delta", item_id: "r1", delta: "hmm" } },
      ctx,
    );
    const e = handleRunItemStreamEvent("message_output_created", { rawItem: {} }, ctx);
    // closes reasoning first, then text message
    expect(e).toEqual([
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "run-1" },
    ]);
    expect(ctx.messageOpen).toBe(false);
    expect(ctx.reasoningOpen).toBe(false);
  });

  it("reasoning_item_created closes an open reasoning block", () => {
    const ctx = new StreamContext("run-1");
    handleRawModelStreamEvent(
      { type: "model", event: { type: "response.reasoning_summary_text.delta", item_id: "r2", delta: "..." } },
      ctx,
    );
    const e = handleRunItemStreamEvent("reasoning_item_created", { rawItem: {} }, ctx);
    expect(e).toEqual([{ type: EventType.REASONING_MESSAGE_END, messageId: "r2" }]);
    expect(ctx.reasoningOpen).toBe(false);
  });

  it("approval/handoff/tool_search items map to CUSTOM events", () => {
    const ctx = new StreamContext("run-1");
    const approval = handleRunItemStreamEvent("tool_approval_requested", {
      rawItem: { callId: "call_f", name: "dangerous" },
      toJSON: () => ({ rawItem: { callId: "call_f" } }),
    }, ctx);
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({ type: EventType.CUSTOM, name: "tool_approval_requested" });

    const handoff = handleRunItemStreamEvent("handoff_occurred", {
      rawItem: {},
      toJSON: () => ({ to: "agent_b" }),
    }, ctx);
    expect(handoff[0]).toMatchObject({ type: EventType.CUSTOM, name: "handoff_occurred" });
  });
});

describe("handlers — agent updated", () => {
  it("emits a CUSTOM agent_updated event with the agent name", () => {
    const e = handleAgentUpdatedStreamEvent({ name: "Researcher" });
    expect(e).toEqual([
      { type: EventType.CUSTOM, name: "agent_updated", value: { name: "Researcher" } },
    ]);
  });
});

describe("handlers — end-of-stream cleanup", () => {
  it("closeOpenBlocks closes an open text message", () => {
    const ctx = new StreamContext("run-1");
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "partial" }, ctx);
    const e = closeOpenBlocks(ctx);
    expect(e).toEqual([{ type: EventType.TEXT_MESSAGE_END, messageId: "run-1" }]);
    expect(ctx.messageOpen).toBe(false);
  });

  it("closeOpenBlocks is a no-op when nothing is open", () => {
    const ctx = new StreamContext("run-1");
    expect(closeOpenBlocks(ctx)).toEqual([]);
  });

  it("buildMessagesSnapshot concatenates input + accumulated", () => {
    const input = [{ id: "m1", role: "user", content: "hi" }] as any;
    const accumulated = [{ id: "m2", role: "assistant", content: "hello" }] as any;
    const out = buildMessagesSnapshot(input, accumulated);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("m1");
    expect(out[1].id).toBe("m2");
  });
});

describe("handlers — state interception (Phase 4)", () => {
  it("intercepts ag_ui_update_state: emits STATE_SNAPSHOT, no TOOL_CALL_*", () => {
    const ctx = new StreamContext("run-1", { count: 1 });
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: JSON.stringify({ state: { count: 2 } }),
      },
    }, ctx);

    expect(e).toEqual([
      { type: EventType.STATE_SNAPSHOT, snapshot: { count: 2 } },
    ]);
    // Not surfaced as a frontend tool call.
    expect(ctx.openToolCalls.has("call_s")).toBe(false);
    expect(ctx.stateToolCallIds.has("call_s")).toBe(true);
    // Replace semantics: currentState is the new object, not merged.
    expect(ctx.currentState).toEqual({ count: 2 });
  });

  it("uses replace semantics (model passes the complete state object)", () => {
    const ctx = new StreamContext("run-1", { a: 1, b: 2 });
    handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: JSON.stringify({ state: { a: 9 } }),
      },
    }, ctx);
    // b is gone — the model's state object replaces, not merges.
    expect(ctx.currentState).toEqual({ a: 9 });
  });

  it("does not emit a duplicate STATE_SNAPSHOT when state is unchanged", () => {
    const ctx = new StreamContext("run-1", { count: 1 });
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: JSON.stringify({ state: { count: 1 } }),
      },
    }, ctx);
    expect(e).toEqual([]);
    expect(ctx.currentState).toEqual({ count: 1 });
  });

  it("accepts a bare state object (no `state` wrapper)", () => {
    const ctx = new StreamContext("run-1", null);
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: JSON.stringify({ items: ["x"] }),
      },
    }, ctx);
    expect(e).toEqual([{ type: EventType.STATE_SNAPSHOT, snapshot: { items: ["x"] } }]);
  });

  it("emits a state_update_error CUSTOM event on malformed JSON args", () => {
    const ctx = new StreamContext("run-1", { count: 1 });
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: "{not json",
      },
    }, ctx);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ type: EventType.CUSTOM, name: "state_update_error" });
    // State left unchanged.
    expect(ctx.currentState).toEqual({ count: 1 });
  });

  it("uses buffered streamed args when present", () => {
    const ctx = new StreamContext("run-1", { count: 0 });
    // arg deltas stream before the tool_called run_item
    handleRawModelStreamEvent(
      { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "call_s", delta: '{"state":' } },
      ctx,
    );
    handleRawModelStreamEvent(
      { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "call_s", delta: '{"count":5}}' } },
      ctx,
    );
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_s", name: STATE_MANAGEMENT_TOOL_NAME, arguments: "" },
    }, ctx);
    expect(e).toEqual([{ type: EventType.STATE_SNAPSHOT, snapshot: { count: 5 } }]);
    expect(ctx.toolCallArgs.has("call_s")).toBe(false);
  });

  it("swallows the state tool's tool_output (no dangling TOOL_CALL_RESULT)", () => {
    const ctx = new StreamContext("run-1", { count: 1 });
    handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: JSON.stringify({ state: { count: 2 } }),
      },
    }, ctx);
    const out = handleRunItemStreamEvent("tool_output", {
      rawItem: { callId: "call_s" },
      output: "ignored",
    }, ctx);
    expect(out).toEqual([]);
    expect(ctx.stateToolCallIds.has("call_s")).toBe(false);
  });
});

describe("handlers — message snapshot merging (Phase 4)", () => {
  it("accumulates assistant text into ctx.messages on close", () => {
    const ctx = new StreamContext("run-1");
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "Hello " }, ctx);
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "world" }, ctx);
    closeOpenBlocks(ctx);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]).toMatchObject({ role: "assistant", content: "Hello world" });
  });

  it("accumulates a tool call onto the assistant message + a tool result message", () => {
    const ctx = new StreamContext("run-1");
    handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "c1", name: "get_weather", arguments: '{"city":"SF"}' },
    }, ctx);
    handleRunItemStreamEvent("tool_output", {
      rawItem: { callId: "c1", name: "get_weather" },
      output: "sunny",
    }, ctx);
    closeOpenBlocks(ctx);

    // One assistant message carrying the tool call, one tool result message.
    const roles = ctx.messages.map((m) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");

    const assistant = ctx.messages.find((m) => m.role === "assistant") as any;
    expect(assistant.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
    ]);

    const tool = ctx.messages.find((m) => m.role === "tool") as any;
    expect(tool).toMatchObject({ id: "c1", role: "tool", toolCallId: "c1", content: "sunny" });
  });

  it("merges accumulated messages into buildMessagesSnapshot", () => {
    const ctx = new StreamContext("run-1");
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "hi" }, ctx);
    closeOpenBlocks(ctx);

    const input = [{ id: "u1", role: "user", content: "hello" }] as any;
    const out = buildMessagesSnapshot(input, ctx.messages);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("u1");
    expect(out[1]).toMatchObject({ role: "assistant", content: "hi" });
  });

  it("does not accumulate the state tool as an assistant tool call", () => {
    const ctx = new StreamContext("run-1", { count: 0 });
    handleRunItemStreamEvent("tool_called", {
      rawItem: {
        callId: "call_s",
        name: STATE_MANAGEMENT_TOOL_NAME,
        arguments: JSON.stringify({ state: { count: 1 } }),
      },
    }, ctx);
    handleRunItemStreamEvent("tool_output", {
      rawItem: { callId: "call_s" },
      output: "ignored",
    }, ctx);
    closeOpenBlocks(ctx);
    // No assistant message (no text, no forwarded tool call) and no tool message.
    expect(ctx.messages).toEqual([]);
  });
});

describe("handlers — frontend-tool HITL halt (Phase 5)", () => {
  it("halts on a frontend tool: emits START/ARGS/END, sets halt, pushes interrupt, no RESULT", () => {
    const ctx = new StreamContext("run-1");
    ctx.frontendToolNames = new Set(["get_weather"]);

    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_fw", name: "get_weather", arguments: '{"city":"SF"}' },
    }, ctx);

    expect(e).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "call_fw", toolCallName: "get_weather" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_fw", delta: '{"city":"SF"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call_fw" },
    ]);
    expect(ctx.halt).toBe(true);
    expect(ctx.openToolCalls.has("call_fw")).toBe(false);
    expect(ctx.interrupts).toEqual([
      { id: "call_fw", reason: "frontend_tool", toolCallId: "call_fw", metadata: { toolName: "get_weather" } },
    ]);
  });

  it("closes an open text message before the frontend tool call", () => {
    const ctx = new StreamContext("run-1");
    ctx.frontendToolNames = new Set(["get_weather"]);
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "Let me check" }, ctx);

    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_fw", name: "get_weather", arguments: '{"city":"SF"}' },
    }, ctx);

    // First event closes the streaming text message.
    expect(e[0]).toEqual({ type: EventType.TEXT_MESSAGE_END, messageId: "run-1" });
    expect(ctx.messageOpen).toBe(false);
    // Then the tool-call lifecycle.
    expect(e[1]).toMatchObject({ type: EventType.TOOL_CALL_START, toolCallId: "call_fw" });
    expect(ctx.halt).toBe(true);
  });

  it("does not halt for a non-frontend tool", () => {
    const ctx = new StreamContext("run-1");
    ctx.frontendToolNames = new Set(["get_weather"]);

    handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_be", name: "backend_lookup", arguments: "{}" },
    }, ctx);

    expect(ctx.halt).toBe(false);
    expect(ctx.interrupts).toEqual([]);
    // A backend tool is tracked as open (its tool_output follows in-run).
    expect(ctx.openToolCalls.has("call_be")).toBe(true);
  });

  it("records the frontend tool call against the assistant message + flushes it", () => {
    const ctx = new StreamContext("run-1");
    ctx.frontendToolNames = new Set(["get_weather"]);
    handleRawModelStreamEvent({ type: "output_text_delta", delta: "Sure" }, ctx);
    handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_fw", name: "get_weather", arguments: '{"city":"SF"}' },
    }, ctx);
    // Halt flushes the pending assistant message.
    expect(ctx.messages).toHaveLength(1);
    const assistant = ctx.messages[0] as any;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Sure");
    expect(assistant.toolCalls).toEqual([
      { id: "call_fw", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
    ]);
  });

  it("uses buffered streamed args for the frontend tool call", () => {
    const ctx = new StreamContext("run-1");
    ctx.frontendToolNames = new Set(["get_weather"]);
    handleRawModelStreamEvent(
      { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "call_fw", delta: '{"city":' } },
      ctx,
    );
    handleRawModelStreamEvent(
      { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "call_fw", delta: '"SF"}' } },
      ctx,
    );
    const e = handleRunItemStreamEvent("tool_called", {
      rawItem: { callId: "call_fw", name: "get_weather", arguments: "" },
    }, ctx);
    expect(e).toEqual([
      { type: EventType.TOOL_CALL_START, toolCallId: "call_fw", toolCallName: "get_weather" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_fw", delta: '{"city":"SF"}' },
      { type: EventType.TOOL_CALL_END, toolCallId: "call_fw" },
    ]);
    expect(ctx.halt).toBe(true);
  });
});
