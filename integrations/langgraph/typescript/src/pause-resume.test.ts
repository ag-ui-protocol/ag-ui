/**
 * Tests for text pause/resume, tool call after pause, orphaned pause cleanup,
 * and stable message ID reuse.
 */

import { describe, it, expect } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/client";
import { LangGraphEventTypes } from "./types";

// Minimal config to construct the agent with pausedTextMessageId support
function createAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  const events: any[] = [];
  (agent as any).subscriber = { next: (e: any) => events.push(e) };
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    pausedTextMessageId: null,
    stableMessageId: null,
  };
  (agent as any).messagesInProcess = {};

  return { agent, events };
}

function chatModelStreamEvent(
  chunkId: string,
  content: string | any[],
  toolCallChunks?: any[],
  finishReason?: string | null,
  metadata?: Record<string, any>,
) {
  return {
    event: LangGraphEventTypes.OnChatModelStream,
    metadata: {
      "emit-messages": true,
      "emit-tool-calls": true,
      ...(metadata ?? {}),
    },
    data: {
      chunk: {
        id: chunkId,
        content,
        tool_call_chunks: toolCallChunks,
        response_metadata: finishReason ? { finish_reason: finishReason } : {},
      },
    },
  };
}

function chatModelEndEvent(outputId?: string) {
  return {
    event: LangGraphEventTypes.OnChatModelEnd,
    data: outputId
      ? { output: { id: outputId, type: "ai" } }
      : { output: null },
  };
}

describe("pause/resume and tool call after pause", () => {
  it("text -> tool -> text produces correct event sequence without premature TextMessageEnd", () => {
    const { agent, events } = createAgent();

    // 1. Text content arrives
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "Let me look that up"),
    );

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(events[0].messageId).toBe("msg-1");
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);

    // 2. Tool call arrives while text is in progress -> pause + tool call start
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [
        { id: "tc-1", name: "search", args: "" },
      ]),
    );

    // Should NOT have a TEXT_MESSAGE_END — message is paused, not ended
    const prematureEnd = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(prematureEnd).toHaveLength(0);

    // Should have TOOL_CALL_START
    const toolStart = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStart).toHaveLength(1);
    expect(toolStart[0].toolCallName).toBe("search");

    // 3. Tool call args
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [{ args: '{"q":"test"}' }]),
    );
    expect(events.some((e) => e.type === EventType.TOOL_CALL_ARGS)).toBe(true);

    // 4. Tool call ends (no tool_call_chunks)
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    const toolEnd = events.filter((e) => e.type === EventType.TOOL_CALL_END);
    expect(toolEnd).toHaveLength(1);

    // 5. New text arrives — should resume paused message, not start new one
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "Here are the results"),
    );

    // Should still only have 1 TEXT_MESSAGE_START total (no second start)
    const textStarts = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    );
    expect(textStarts).toHaveLength(1);

    // The resumed text content should use the original paused message ID
    const textContents = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    const lastContent = textContents[textContents.length - 1];
    expect(lastContent.messageId).toBe("msg-1");

    // 6. Model ends — should emit exactly one TextMessageEnd for the full message
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(textEnds).toHaveLength(1);
    expect(textEnds[0].messageId).toBe("msg-1");
  });

  it("tool call start is not dropped after pause clears messagesInProcess", () => {
    const { agent, events } = createAgent();

    // 1. Text content arrives
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Thinking..."));

    // 2. Tool call arrives while text is in progress
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [
        { id: "tc-1", name: "lookup", args: "" },
      ]),
    );

    // The tool call start MUST be emitted despite the pause clearing messagesInProcess
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].toolCallId).toBe("tc-1");
    expect(toolStarts[0].toolCallName).toBe("lookup");
  });
});

describe("paused message orphaned on model end", () => {
  it("text -> tool -> model_end produces TextMessageEnd for paused message", () => {
    const { agent, events } = createAgent();

    // 1. Text content starts
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Let me check"));

    // 2. Tool call pauses the text
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [
        { id: "tc-1", name: "search", args: "" },
      ]),
    );

    // 3. Tool call ends
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    // 4. Model ends without resuming text
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    // The paused text message should get a TEXT_MESSAGE_END
    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(textEnds).toHaveLength(1);
    expect(textEnds[0].messageId).toBe("msg-1");
  });

  it("model end without paused message does not emit spurious TextMessageEnd", () => {
    const { agent, events } = createAgent();

    // Just a tool call, no text pause
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [
        { id: "tc-1", name: "search", args: "" },
      ]),
    );
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [{ args: '{"q":"test"}' }]),
    );
    // Tool call end
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    // Model end
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    // TOOL_CALL_END emitted, but no TEXT_MESSAGE_END
    const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);
    expect(toolEnds).toHaveLength(1);

    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(textEnds).toHaveLength(0);
  });
});

describe("stable message ID reuse across chunks", () => {
  it("uses the first chunk message ID for all subsequent text messages", () => {
    const { agent, events } = createAgent();

    // First chunk with id "msg-1"
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Hello"));

    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
    expect(events[0].messageId).toBe("msg-1");

    // Second chunk — different id from platform ("msg-1-chunk-2") but should reuse msg-1
    agent.handleSingleEvent(chatModelStreamEvent("msg-1-chunk-2", " world"));

    // The content should still reference msg-1
    const contentEvents = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(contentEvents).toHaveLength(2);
    expect(contentEvents[1].messageId).toBe("msg-1");
  });

  it("stable message ID resets after model end, new model turn gets fresh ID", () => {
    const { agent, events } = createAgent();

    // Text starts with id "msg-1"
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Searching..."));

    // Tool call pauses text
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [
        { id: "tc-1", name: "search", args: "" },
      ]),
    );

    // Tool call ends
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    // Text resumes — paused ID takes priority for this continuation
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Results found"));

    // Model ends — stableMessageId is cleared
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    // New model turn with different platform ID
    agent.handleSingleEvent(chatModelStreamEvent("msg-2", "More info"));

    // stableMessageId was reset on model end, so second turn uses fresh ID
    const textStarts = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    );
    // Two starts: first from model turn 1, second from model turn 2
    expect(textStarts).toHaveLength(2);
    expect(textStarts[0].messageId).toBe("msg-1");
    expect(textStarts[1].messageId).toBe("msg-2"); // fresh ID for new turn
  });
});

describe("deferred TextMessageEnd — empty chunk before tool call", () => {
  it("empty chunk between text and tool call does not emit premature TextMessageEnd", () => {
    const { agent, events } = createAgent();

    // 1. Text content arrives
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "Let me search for that"),
    );
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_START),
    ).toHaveLength(1);

    // 2. Empty chunk arrives (no content, no tool calls) — some models emit this
    //    between text output and tool call initiation
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    // TextMessageEnd must NOT fire here — the run may not be complete
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_END),
    ).toHaveLength(0);

    // 3. Tool call arrives
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "", [
        { id: "tc-1", name: "search", args: "" },
      ]),
    );

    // Tool call start should still work
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(1);

    // Still no TextMessageEnd
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_END),
    ).toHaveLength(0);

    // 4. Tool call ends
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    // 5. More text arrives
    agent.handleSingleEvent(
      chatModelStreamEvent("msg-1", "Here are the results"),
    );

    // Only 1 TextMessageStart total (resumed, not new)
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_START),
    ).toHaveLength(1);

    // 6. Model ends — now TextMessageEnd should fire exactly once
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(textEnds).toHaveLength(1);
    expect(textEnds[0].messageId).toBe("msg-1");
  });

  it("text followed by model end (no tool calls) still emits TextMessageEnd", () => {
    const { agent, events } = createAgent();

    // 1. Text content
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Hello world"));

    // 2. Model ends normally
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(textEnds).toHaveLength(1);
    expect(textEnds[0].messageId).toBe("msg-1");
  });

  it("empty chunk then model end (simple case) still emits TextMessageEnd", () => {
    const { agent, events } = createAgent();

    // 1. Text content
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "Thinking..."));

    // 2. Empty chunk
    agent.handleSingleEvent(chatModelStreamEvent("msg-1", "", undefined));

    // No TextMessageEnd yet (deferred)
    expect(
      events.filter((e) => e.type === EventType.TEXT_MESSAGE_END),
    ).toHaveLength(0);

    // 3. Model ends
    agent.handleSingleEvent(chatModelEndEvent("msg-1"));

    // Now TextMessageEnd fires
    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );
    expect(textEnds).toHaveLength(1);
    expect(textEnds[0].messageId).toBe("msg-1");
  });
});

describe("pausedTextMessageId initialization", () => {
  it("activeRun initializes with pausedTextMessageId null", () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
    });

    // Simulate what runAgentStream does
    (agent as any).activeRun = {
      id: "run-1",
      threadId: "thread-1",
      hasFunctionStreaming: false,
      pausedTextMessageId: null,
      stableMessageId: null,
    };

    expect((agent as any).activeRun.pausedTextMessageId).toBeNull();
    expect((agent as any).activeRun.stableMessageId).toBeNull();
  });
});
