import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, PROTOCOL_VERSION, type Event } from "@ag-ui/core";
import { createTranslator, toAguiMessages, type HistoryEntry } from "@ag-ui/pi";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";

const model: Model<"openai-completions"> = {
  api: "openai-completions",
  provider: "fixture",
  id: "test",
  name: "test",
  reasoning: false,
  input: ["text"],
  baseUrl: "http://127.0.0.1:1",
  contextWindow: 1024,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: "stop",
    timestamp: 123,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const ids = { threadId: "thread-1", runId: "run-1" };

test("a Pi core loop streams split text and leaves completion to its caller", async () => {
  const translator = createTranslator({
    ...ids,
    completion: "caller",
    messageId: () => "stable-1",
  });
  assert.deepEqual(translator.start(), [
    { type: EventType.RUN_STARTED, ...ids, protocolVersion: PROTOCOL_VERSION },
  ]);
  assert.deepEqual(translator.start(), []);
  const events: Event[] = [];
  await runAgentLoop(
    [{ role: "user", content: "hello", timestamp: 1 }],
    { messages: [] },
    {
      model,
      convertToLlm: (messages) => messages.filter((m) => m.role === "user"),
    },
    (event) => {
      events.push(...translator.translate(event));
    },
    undefined,
    () => {
      const stream = createAssistantMessageEventStream();
      const message = assistant([{ type: "text", text: "three parts!" }]);
      stream.push({ type: "start", partial: message });
      for (const delta of ["three", " parts"]) {
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          partial: message,
          delta,
        });
      }
      stream.push({
        type: "text_end",
        contentIndex: 0,
        partial: message,
        content: "three parts!",
      });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  );
  const messageId = "stable-1";
  assert.deepEqual(events, [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "three" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: " parts" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "!" },
    { type: EventType.TEXT_MESSAGE_END, messageId },
  ]);
  assert.deepEqual(
    translator.translate({ type: "agent_settled", aborted: false }),
    [],
  );
  assert.deepEqual(translator.finish(), [
    { type: EventType.RUN_FINISHED, ...ids },
  ]);
  assert.deepEqual(translator.finish(), []);
  assert.deepEqual(translator.start(), []);
});

test("tool calls close their arguments before the matching native results arrive", () => {
  const message = assistant(
    ["x", "y"].map((id) => ({
      type: "toolCall",
      name: "lookup",
      id,
      arguments: { key: id },
    })),
  );
  const translator = createTranslator({
    ...ids,
    completion: "caller",
    messageId: (m) =>
      m.role === "assistant" ? "parent" : `result-${m.toolCallId}`,
  });
  translator.start();
  translator.translate({ type: "message_start", message });
  const calls = translator.translate({ type: "message_end", message });
  assert.deepEqual(
    calls,
    ["x", "y"].flatMap((toolCallId) => [
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "parent",
        toolCallId,
        toolCallName: "lookup",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: JSON.stringify({ key: toolCallId }),
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ]),
  );

  for (const id of ["y", "x"]) {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      toolName: "lookup",
      timestamp: 123,
      content: [{ type: "text", text: `found ${id}` }],
      isError: false,
      details: "private",
    };
    assert.deepEqual(
      translator.translate({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "lookup",
        result,
        isError: false,
      }),
      [],
    );
    assert.deepEqual(
      translator.translate({ type: "message_end", message: result }),
      [
        {
          type: EventType.TOOL_CALL_RESULT,
          role: "tool",
          toolCallId: id,
          messageId: `result-${id}`,
          content: `found ${id}`,
        },
      ],
    );
    assert.deepEqual(
      translator.translate({ type: "message_end", message: result }),
      [],
    );
  }
});

test("an interrupted tool proposal is absent from live events and history", () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const message = assistant([
      { type: "toolCall", name: "calculate", id: "partial", arguments: {} },
    ]);
    message.stopReason = stopReason;
    const translator = createTranslator({ ...ids, completion: "session" });
    translator.start();
    translator.translate({ type: "message_start", message });
    assert.deepEqual(
      translator.translate({ type: "message_end", message }),
      [],
    );
    assert.deepEqual(toAguiMessages([{ id: "incomplete", message }]), []);
  }
});

test("a session can retry after agent_end and reports only the settled outcome", () => {
  for (const retry of [true, false]) {
    const translator = createTranslator({ ...ids, completion: "session" });
    const failed: AssistantMessage = {
      ...assistant([]),
      stopReason: "error",
      errorMessage: "provider secret",
    };
    translator.start();
    translator.translate({ type: "message_start", message: failed });
    translator.translate({ type: "message_end", message: failed });
    assert.deepEqual(
      translator.translate({
        type: "agent_end",
        messages: [failed],
        willRetry: retry,
      }),
      [],
    );
    if (retry) {
      const success = assistant([{ type: "text", text: "done" }]);
      translator.translate({ type: "message_start", message: success });
      translator.translate({ type: "message_end", message: success });
    }
    const settled = translator.translate({
      type: "agent_settled",
      aborted: false,
    });
    assert.deepEqual(
      settled,
      retry
        ? [{ type: EventType.RUN_FINISHED, ...ids }]
        : [{ type: EventType.RUN_ERROR, message: "Pi model request failed" }],
    );
    assert.deepEqual(
      translator.translate({ type: "agent_settled", aborted: false }),
      [],
    );
    assert.deepEqual(translator.error("late error"), []);
  }
});

test("explicit failure closes the open text message and discards late native input", () => {
  const translator = createTranslator({
    ...ids,
    completion: "caller",
    messageId: () => "stable",
  });
  const message = assistant([]);
  translator.start();
  translator.translate({ type: "message_start", message });
  translator.translate({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "partial",
      partial: message,
    },
  });
  assert.deepEqual(translator.error("Disconnected"), [
    { type: EventType.TEXT_MESSAGE_END, messageId: "stable" },
    { type: EventType.RUN_ERROR, message: "Disconnected" },
  ]);
  assert.deepEqual(translator.translate({ type: "message_end", message }), []);
  assert.deepEqual(translator.finish(), []);
});

test("history preserves native call IDs and caller-owned message IDs across projections", () => {
  const entries: HistoryEntry[] = [
    {
      id: "sys",
      message: {
        role: "system",
        content: "private instructions",
        timestamp: 1,
      },
    },
    { id: "user", message: { role: "user", content: "find it", timestamp: 2 } },
    {
      id: "agent",
      message: assistant([
        {
          type: "thinking",
          thinking: "private reasoning",
          thinkingSignature: "private signature",
        },
        { type: "text", text: "Checking" },
        {
          type: "toolCall",
          id: "call",
          name: "lookup",
          arguments: { key: "x" },
        },
      ]),
    },
    {
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "lookup",
        isError: true,
        content: [{ type: "text", text: "missing" }],
        timestamp: 3,
      },
    },
  ];
  const expected = [
    { id: "user", role: "user", content: "find it" },
    {
      id: "agent",
      role: "assistant",
      content: "Checking",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "lookup", arguments: '{"key":"x"}' },
        },
      ],
    },
    {
      id: "result",
      role: "tool",
      toolCallId: "call",
      content: "missing",
      error: "missing",
    },
  ];
  assert.deepEqual(toAguiMessages(entries.slice(2)), expected.slice(1));
  const translator = createTranslator({
    ...ids,
    completion: "session",
    getMessages: () => toAguiMessages(entries),
  });
  translator.start();
  assert.deepEqual(
    translator.translate({ type: "agent_settled", aborted: false }),
    [
      { type: EventType.MESSAGES_SNAPSHOT, messages: expected },
      { type: EventType.RUN_FINISHED, ...ids },
    ],
  );
});
