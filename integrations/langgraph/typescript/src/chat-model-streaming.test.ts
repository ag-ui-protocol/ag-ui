/**
 * Tests for the additive OnChatModelStream routing in handleSingleEvent.
 *
 * Each on_chat_model_stream chunk can carry interleaved text content and a
 * tool_call_chunk (e.g. Anthropic), and text/tool can transition into one
 * another mid-stream. The case routes each payload kind additively per chunk
 * rather than choosing one via mutually-exclusive booleans + early break/return.
 *
 * Regression coverage for:
 * - interleaved text + tool in a single chunk (text must not be dropped)
 * - text->tool / tool->text / tool->tool transitions
 * - back-to-back tool calls while one is already streaming (ag-ui-protocol/ag-ui#871)
 * - trailing deltas on a finish_reason chunk (must not be dropped)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/client";

function createAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  (agent as any).subscriber = { next: () => {} };
  (agent as any).activeRun = {
    id: "run-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  (agent as any).emittedToolCallStartIds = new Set<string>();
  (agent as any).messagesInProcess = {};

  const dispatched: any[] = [];
  const spy = vi.spyOn(agent as any, "dispatchEvent");
  spy.mockImplementation((event: any) => {
    dispatched.push(event);
    return true;
  });

  return { agent, dispatched };
}

type StreamChunkOpts = {
  id?: string;
  content?: any;
  toolCallChunks?: Array<{ id?: string; name?: string; args?: string }>;
  finishReason?: string | null;
  emitMessages?: boolean;
  emitToolCalls?: boolean;
  predictState?: Array<{
    tool: string;
    state_key: string;
    tool_argument: string;
  }>;
};

function streamEvent(opts: StreamChunkOpts = {}) {
  const metadata: Record<string, any> = {
    "emit-messages": opts.emitMessages ?? true,
    "emit-tool-calls": opts.emitToolCalls ?? true,
  };
  if (opts.predictState) metadata["predict_state"] = opts.predictState;

  return {
    event: "on_chat_model_stream",
    metadata,
    data: {
      chunk: {
        id: opts.id ?? "msg-1",
        content: opts.content ?? "",
        tool_call_chunks: opts.toolCallChunks,
        response_metadata: opts.finishReason
          ? { finish_reason: opts.finishReason }
          : {},
      },
    },
  };
}

const typesOf = (events: any[]) => events.map((e) => e.type);

describe("OnChatModelStream additive routing", () => {
  let agent: LangGraphAgent;
  let dispatched: any[];

  beforeEach(() => {
    ({ agent, dispatched } = createAgent());
  });

  it("emits TEXT_MESSAGE_START + CONTENT for the first text chunk", () => {
    agent.handleSingleEvent(streamEvent({ id: "msg-1", content: "Hello" }));

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      role: "assistant",
      messageId: "msg-1",
    });
    expect(dispatched[1]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "Hello",
    });
  });

  it("emits only CONTENT for continued text chunks", () => {
    agent.handleSingleEvent(streamEvent({ id: "msg-1", content: "Hello" }));
    agent.handleSingleEvent(streamEvent({ id: "msg-1", content: " world" }));

    expect(dispatched).toHaveLength(3);
    expect(dispatched[2]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: " world",
    });
  });

  it("closes the open text message before starting a tool call (text->tool)", () => {
    agent.handleSingleEvent(
      streamEvent({ id: "msg-1", content: "Let me search" }),
    );
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        toolCallChunks: [{ id: "tc-1", name: "search", args: "" }],
      }),
    );

    expect(typesOf(dispatched)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
    ]);
    const toolStart = dispatched.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStart).toMatchObject({
      toolCallId: "tc-1",
      toolCallName: "search",
    });
  });

  it("emits TOOL_CALL_ARGS after a tool call start", () => {
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        toolCallChunks: [{ id: "tc-1", name: "search", args: "" }],
      }),
    );
    agent.handleSingleEvent(
      streamEvent({ id: "msg-1", toolCallChunks: [{ args: '{"query":' }] }),
    );

    expect(typesOf(dispatched)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
    ]);
    expect(dispatched[1]).toMatchObject({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: '{"query":',
    });
  });

  it("keeps text AND tool call when both arrive in the SAME chunk", () => {
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        content: "Looking that up",
        toolCallChunks: [{ id: "tc-1", name: "search", args: "" }],
      }),
    );

    // Text is not dropped, and is closed before the tool call opens.
    expect(typesOf(dispatched)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
    ]);
    expect(dispatched[1]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: "Looking that up",
    });
  });

  it("closes the first tool call before starting a second one (#871)", () => {
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        toolCallChunks: [{ id: "tc-1", name: "search", args: "" }],
      }),
    );
    // A second tool call begins while the first is still open.
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        toolCallChunks: [{ id: "tc-2", name: "lookup", args: "" }],
      }),
    );

    expect(typesOf(dispatched)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_START,
    ]);
    expect(dispatched[0]).toMatchObject({ toolCallId: "tc-1" });
    expect(dispatched[1]).toMatchObject({ toolCallId: "tc-1" });
    expect(dispatched[2]).toMatchObject({
      toolCallId: "tc-2",
      toolCallName: "lookup",
    });
  });

  it("does NOT drop trailing content on a finish_reason chunk", () => {
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        content: "final words",
        finishReason: "stop",
      }),
    );

    const content = dispatched.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(content).toMatchObject({ delta: "final words" });
  });

  it("emits nothing when both emit-messages and emit-tool-calls are false", () => {
    agent.handleSingleEvent(
      streamEvent({
        id: "msg-1",
        content: "ignored",
        toolCallChunks: [{ id: "tc-1", name: "search", args: "" }],
        emitMessages: false,
        emitToolCalls: false,
      }),
    );

    expect(dispatched).toHaveLength(0);
  });
});
