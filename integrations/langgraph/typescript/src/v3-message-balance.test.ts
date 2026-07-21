/**
 * Finding 8 — handleSingleEventV3 stream-balance.
 *
 * The client raw-translate path (v3 `messages` channel) must emit balanced
 * START/END events for text / reasoning / tool content blocks:
 *
 *  - message-error closes any open text/reasoning/tool block (previously it
 *    cleared the text tracker WITHOUT a TEXT_MESSAGE_END).
 *  - multiple text content-blocks sharing one message id yield exactly one
 *    START and one END (previously a duplicate START/END per block).
 *  - message-finish closes open tool/reasoning blocks (previously only text).
 *  - a tool call whose name arrives on a later block-delta gets a non-empty
 *    toolCallName on its single TOOL_CALL_START (previously START fired with
 *    an empty name at content-block-start).
 */

import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

const EMPTY_STATE = {
  values: { messages: [] },
  tasks: [],
  next: [],
  metadata: { writes: {} },
};

function makeConfig(getStateResult: any = EMPTY_STATE): LangGraphAgentConfig {
  return {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: {
      threads: { getState: vi.fn().mockResolvedValue(getStateResult) },
      runs: { cancel: vi.fn() },
    } as any,
  };
}

function makeChunk(method: string, data: any) {
  return { type: "event", seq: 0, method, params: { namespace: [], timestamp: 0, data } };
}

async function* makeStream(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function runV3(chunks: any[]) {
  const agent = new LangGraphAgent(makeConfig());
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return true as any;
  };
  (agent as any).activeRun = {
    id: "run1",
    threadId: "thread1",
    nodeName: "chat",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  (agent as any).emittedToolCallStartIds = new Set();

  await (agent as any).handleStreamEventsV3(
    { streamResponse: makeStream(chunks), state: { ...EMPTY_STATE } },
    "thread1",
    { next: (e: any) => dispatched.push(e), error: () => {}, complete: () => {} },
    {
      runId: "run1",
      threadId: "thread1",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: { nodeName: "chat" },
    },
    [],
  );
  return dispatched;
}

const byType = (d: any[], t: EventType) => d.filter((e) => e.type === t);

// ---------------------------------------------------------------------------
// message-error closes open blocks (was: cleared without END)
// ---------------------------------------------------------------------------

describe("message-error closes open blocks", () => {
  it("emits TEXT_MESSAGE_END for an open text block on message-error", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", { event: "content-block-start", index: 0, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-delta", index: 0, delta: { type: "text-delta", text: "hi" } }),
      makeChunk("messages", { event: "message-error" }),
    ]);
    const starts = byType(dispatched, EventType.TEXT_MESSAGE_START);
    const ends = byType(dispatched, EventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].messageId).toBe("m1");
  });

  it("closes an open tool block on message-error", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc-1", name: "search" },
      }),
      makeChunk("messages", { event: "message-error" }),
    ]);
    expect(byType(dispatched, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// multiple text content-blocks reusing one message id
// ---------------------------------------------------------------------------

describe("multiple text blocks under one message id", () => {
  it("emits exactly one START and one END across two text blocks", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", { event: "content-block-start", index: 0, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-start", index: 1, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-finish", index: 0, content: { type: "text" } }),
      makeChunk("messages", { event: "content-block-finish", index: 1, content: { type: "text" } }),
    ]);
    const starts = byType(dispatched, EventType.TEXT_MESSAGE_START);
    const ends = byType(dispatched, EventType.TEXT_MESSAGE_END);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0].messageId).toBe("m1");
    expect(ends[0].messageId).toBe("m1");
  });
});

// ---------------------------------------------------------------------------
// message-finish closes open tool / reasoning blocks
// ---------------------------------------------------------------------------

describe("message-finish closes non-text blocks", () => {
  it("closes an open tool block on message-finish", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "tc-1", name: "search", args: "{}" },
      }),
      makeChunk("messages", { event: "message-finish" }),
    ]);
    expect(byType(dispatched, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
  });

  it("closes an open reasoning block on message-finish", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning", reasoning: "thinking..." },
      }),
      makeChunk("messages", { event: "message-finish" }),
    ]);
    expect(byType(dispatched, EventType.REASONING_MESSAGE_END)).toHaveLength(1);
    expect(byType(dispatched, EventType.REASONING_END)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// tool name arriving on a later block-delta
// ---------------------------------------------------------------------------

describe("deferred tool name", () => {
  it("emits a single TOOL_CALL_START with the name from a later block-delta", async () => {
    const dispatched = await runV3([
      makeChunk("messages", { event: "message-start", id: "m1" }),
      // Opening block carries NO name.
      makeChunk("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call_chunk", id: "tc-1" },
      }),
      // Name (and args) arrive on the delta.
      makeChunk("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "block-delta", fields: { name: "search", args: '{"q":1}' } },
      }),
      makeChunk("messages", { event: "content-block-finish", index: 0, content: { type: "tool_call_chunk" } }),
    ]);
    const starts = byType(dispatched, EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallName).toBe("search");
    // The buffered args are flushed once, and the call is balanced.
    expect(byType(dispatched, EventType.TOOL_CALL_END)).toHaveLength(1);
    const args = byType(dispatched, EventType.TOOL_CALL_ARGS);
    expect(args.map((a) => a.delta).join("")).toBe('{"q":1}');
  });
});
