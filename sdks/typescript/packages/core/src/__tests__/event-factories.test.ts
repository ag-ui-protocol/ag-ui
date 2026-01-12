import {
  createActivityDeltaEvent,
  createActivitySnapshotEvent,
  createCustomEvent,
  createMessagesSnapshotEvent,
  createRawEvent,
  createRunErrorEvent,
  createRunFinishedEvent,
  createRunStartedEvent,
  createStateDeltaEvent,
  createStateSnapshotEvent,
  createStepFinishedEvent,
  createStepStartedEvent,
  createTextMessageChunkEvent,
  createTextMessageContentEvent,
  createTextMessageEndEvent,
  createTextMessageStartEvent,
  createThinkingEndEvent,
  createThinkingStartEvent,
  createThinkingTextMessageContentEvent,
  createThinkingTextMessageEndEvent,
  createThinkingTextMessageStartEvent,
  createToolCallArgsEvent,
  createToolCallChunkEvent,
  createToolCallEndEvent,
  createToolCallResultEvent,
  createToolCallStartEvent,
} from "../event-factories";
import { EventType } from "../events";

describe("event factories", () => {
  it("creates TEXT_MESSAGE_START with default assistant role", () => {
    const event = createTextMessageStartEvent({ messageId: "msg-1" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(event.messageId).toBe("msg-1");
    expect(event.role).toBe("assistant");
  });

  it("creates TEXT_MESSAGE_START with custom role", () => {
    const event = createTextMessageStartEvent({ messageId: "msg-2", role: "user" });

    expect(event.role).toBe("user");
  });

  it("rejects empty deltas in TEXT_MESSAGE_CONTENT", () => {
    expect(() => createTextMessageContentEvent({ messageId: "msg-3", delta: "" })).toThrow(
      /Delta must not be an empty string/,
    );
  });

  it("creates TEXT_MESSAGE_CONTENT when delta provided", () => {
    const event = createTextMessageContentEvent({ messageId: "msg-4", delta: "hi" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(event.delta).toBe("hi");
  });

  it("creates TEXT_MESSAGE_END", () => {
    const event = createTextMessageEndEvent({ messageId: "msg-5" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(event.messageId).toBe("msg-5");
  });

  it("creates TEXT_MESSAGE_CHUNK with optional fields", () => {
    const event = createTextMessageChunkEvent({ delta: "partial" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect(event.delta).toBe("partial");
    expect(event.messageId).toBeUndefined();
  });

  it("creates THINKING_TEXT_MESSAGE_START/CONTENT/END", () => {
    const start = createThinkingTextMessageStartEvent({});
    const content = createThinkingTextMessageContentEvent({ delta: "thinking…" });
    const end = createThinkingTextMessageEndEvent({});

    expect(start.type).toBe(EventType.THINKING_TEXT_MESSAGE_START);
    expect(content.type).toBe(EventType.THINKING_TEXT_MESSAGE_CONTENT);
    expect(content.delta).toBe("thinking…");
    expect(end.type).toBe(EventType.THINKING_TEXT_MESSAGE_END);
  });

  it("creates TOOL_CALL_START/ARGS/END/CHUNK/RESULT", () => {
    const start = createToolCallStartEvent({
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId: "msg-parent",
    });
    const args = createToolCallArgsEvent({ toolCallId: "tc-1", delta: '{"q":"hi"}' });
    const chunk = createToolCallChunkEvent({
      toolCallId: "tc-1",
      toolCallName: "search",
      delta: "partial",
    });
    const end = createToolCallEndEvent({ toolCallId: "tc-1" });
    const result = createToolCallResultEvent({
      messageId: "msg-6",
      toolCallId: "tc-1",
      content: '{"ok":true}',
      role: "tool",
    });

    expect(start.type).toBe(EventType.TOOL_CALL_START);
    expect(start.parentMessageId).toBe("msg-parent");
    expect(args.delta).toContain("q");
    expect(chunk.delta).toBe("partial");
    expect(end.type).toBe(EventType.TOOL_CALL_END);
    expect(result.role).toBe("tool");
    expect(result.content).toBe('{"ok":true}');
  });

  it("creates THINKING_START/END", () => {
    const start = createThinkingStartEvent({ title: "working" });
    const end = createThinkingEndEvent({});

    expect(start.type).toBe(EventType.THINKING_START);
    expect(start.title).toBe("working");
    expect(end.type).toBe(EventType.THINKING_END);
  });

  it("creates STATE_SNAPSHOT and STATE_DELTA", () => {
    const snapshot = createStateSnapshotEvent({ snapshot: { step: 1 } });
    const delta = createStateDeltaEvent({ delta: [{ op: "add", path: "/foo", value: "bar" }] });

    expect(snapshot.type).toBe(EventType.STATE_SNAPSHOT);
    expect(snapshot.snapshot).toEqual({ step: 1 });
    expect(delta.type).toBe(EventType.STATE_DELTA);
    expect(delta.delta[0]).toMatchObject({ op: "add" });
  });

  it("creates MESSAGES_SNAPSHOT and validates nested messages", () => {
    const event = createMessagesSnapshotEvent({
      messages: [
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "hi there" },
      ],
      timestamp: 123,
    });

    expect(event.type).toBe(EventType.MESSAGES_SNAPSHOT);
    expect(event.messages).toHaveLength(2);
    expect(event.timestamp).toBe(123);
  });

  it("creates ACTIVITY_SNAPSHOT and ACTIVITY_DELTA", () => {
    const snapshot = createActivitySnapshotEvent({
      messageId: "activity-1",
      activityType: "PLAN",
      content: { steps: [] },
    });
    const delta = createActivityDeltaEvent({
      messageId: "activity-1",
      activityType: "PLAN",
      patch: [{ op: "replace", path: "/steps/0", value: "done" }],
    });

    expect(snapshot.type).toBe(EventType.ACTIVITY_SNAPSHOT);
    expect(snapshot.replace).toBe(true);
    expect(delta.type).toBe(EventType.ACTIVITY_DELTA);
    expect(delta.patch[0].path).toBe("/steps/0");
  });

  it("creates RAW and CUSTOM events", () => {
    const raw = createRawEvent({ event: { any: true }, source: "webhook" });
    const custom = createCustomEvent({ name: "metric", value: 42 });

    expect(raw.type).toBe(EventType.RAW);
    expect(raw.source).toBe("webhook");
    expect(custom.type).toBe(EventType.CUSTOM);
    expect(custom.value).toBe(42);
  });

  it("creates RUN events", () => {
    const started = createRunStartedEvent({
      threadId: "t1",
      runId: "r1",
      input: { threadId: "t1", runId: "r1", state: {}, messages: [], tools: [], context: [], forwardedProps: {} },
    });
    const finished = createRunFinishedEvent({ threadId: "t1", runId: "r1", result: { ok: true } });
    const error = createRunErrorEvent({ message: "boom", code: "E_FAIL" });

    expect(started.type).toBe(EventType.RUN_STARTED);
    expect(started.input?.runId).toBe("r1");
    expect(finished.result).toEqual({ ok: true });
    expect(error.code).toBe("E_FAIL");
  });

  it("creates STEP events", () => {
    const started = createStepStartedEvent({ stepName: "fetch" });
    const finished = createStepFinishedEvent({ stepName: "fetch" });

    expect(started.type).toBe(EventType.STEP_STARTED);
    expect(finished.type).toBe(EventType.STEP_FINISHED);
    expect(finished.stepName).toBe("fetch");
  });
});
