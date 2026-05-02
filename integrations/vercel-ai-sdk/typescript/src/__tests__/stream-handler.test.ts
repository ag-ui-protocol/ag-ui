import { describe, expect, it } from "vitest";
import {
  EventType,
  type AssistantMessage,
  type MessagesSnapshotEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type TextMessageContentEvent,
  type TextMessageStartEvent,
  type TextMessageEndEvent,
} from "@ag-ui/client";
import { streamText } from "ai";
import {
  collectEvents,
  eventsOfType,
  makeMockModel,
  streamStart,
  responseMetadata,
  finishStop,
} from "./helpers";

describe("StreamHandler — basic text + lifecycle", () => {
  it("emits RUN_STARTED first and RUN_FINISHED last", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "Hello" },
      { type: "text-end", id: "m1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("RUN_STARTED carries threadId and runId from input", async () => {
    const model = makeMockModel([streamStart, responseMetadata(), finishStop()]);
    const events = await collectEvents(
      streamText({ model, prompt: "hi" }).fullStream,
      { threadId: "thread-xyz", runId: "run-abc" },
    );
    const started = events.find((e) => e.type === EventType.RUN_STARTED) as RunStartedEvent;
    expect(started.threadId).toBe("thread-xyz");
    expect(started.runId).toBe("run-abc");

    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as RunFinishedEvent;
    expect(finished.threadId).toBe("thread-xyz");
    expect(finished.runId).toBe("run-abc");
  });

  it("emits TEXT_MESSAGE_START / CONTENT / END with consistent messageId from text-start.id", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "msg-1" },
      { type: "text-delta", id: "msg-1", delta: "Hello " },
      { type: "text-delta", id: "msg-1", delta: "world" },
      { type: "text-end", id: "msg-1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);

    const start = events.find((e) => e.type === EventType.TEXT_MESSAGE_START) as TextMessageStartEvent;
    expect(start).toBeDefined();
    expect(start.messageId).toBe("msg-1");
    expect(start.role).toBe("assistant");

    const contents = eventsOfType<TextMessageContentEvent>(events, EventType.TEXT_MESSAGE_CONTENT);
    expect(contents).toHaveLength(2);
    expect(contents.map((e) => e.delta).join("")).toBe("Hello world");
    expect(contents.every((e) => e.messageId === "msg-1")).toBe(true);

    const end = events.find((e) => e.type === EventType.TEXT_MESSAGE_END) as TextMessageEndEvent;
    expect(end.messageId).toBe("msg-1");
  });

  it("accumulates text into the assistant message content for MESSAGES_SNAPSHOT", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "msg-1" },
      { type: "text-delta", id: "msg-1", delta: "Hello " },
      { type: "text-delta", id: "msg-1", delta: "world" },
      { type: "text-end", id: "msg-1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const assistant = snapshot.messages.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.content).toBe("Hello world");
  });

  it("does NOT push a trailing empty assistant message when there is no content", async () => {
    const model = makeMockModel([streamStart, responseMetadata(), finishStop()]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream, {
      messages: [{ id: "u1", role: "user", content: "Hi" }],
    });
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].role).toBe("user");
  });

  it("supports multiple text segments in the same step (different messageIds)", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "seg-a" },
      { type: "text-delta", id: "seg-a", delta: "Let me check." },
      { type: "text-end", id: "seg-a" },
      { type: "text-start", id: "seg-b" },
      { type: "text-delta", id: "seg-b", delta: "Done." },
      { type: "text-end", id: "seg-b" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);

    const starts = eventsOfType<TextMessageStartEvent>(events, EventType.TEXT_MESSAGE_START);
    expect(starts.map((e) => e.messageId)).toEqual(["seg-a", "seg-b"]);

    const ends = eventsOfType<TextMessageEndEvent>(events, EventType.TEXT_MESSAGE_END);
    expect(ends.map((e) => e.messageId)).toEqual(["seg-a", "seg-b"]);
  });

  it("MESSAGES_SNAPSHOT preserves prior input messages", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "ok" },
      { type: "text-end", id: "m1" },
      finishStop(),
    ]);
    const events = await collectEvents(
      streamText({ model, prompt: "hi" }).fullStream,
      {
        messages: [
          { id: "sys", role: "system", content: "You are helpful" },
          { id: "u1", role: "user", content: "Hi" },
        ],
      },
    );
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const ids = snapshot.messages.map((m) => m.id);
    expect(ids[0]).toBe("sys");
    expect(ids[1]).toBe("u1");
    expect(snapshot.messages.at(-1)?.role).toBe("assistant");
  });

  it("emits MESSAGES_SNAPSHOT immediately before RUN_FINISHED", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "hi" },
      { type: "text-end", id: "m1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);
    const snapIdx = events.findIndex((e) => e.type === EventType.MESSAGES_SNAPSHOT);
    const finIdx = events.findIndex((e) => e.type === EventType.RUN_FINISHED);
    expect(snapIdx).toBeGreaterThan(0);
    expect(finIdx).toBe(snapIdx + 1);
  });

  it("emits STEP_STARTED and STEP_FINISHED bracketing the stream content", async () => {
    const model = makeMockModel([
      streamStart,
      responseMetadata(),
      { type: "text-start", id: "m1" },
      { type: "text-delta", id: "m1", delta: "hi" },
      { type: "text-end", id: "m1" },
      finishStop(),
    ]);
    const events = await collectEvents(streamText({ model, prompt: "hi" }).fullStream);

    const startedIdx = events.findIndex((e) => e.type === EventType.STEP_STARTED);
    const finishedIdx = events.findIndex((e) => e.type === EventType.STEP_FINISHED);
    const textStartIdx = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(startedIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(startedIdx);
    expect(textStartIdx).toBeGreaterThan(startedIdx);
    expect(textStartIdx).toBeLessThan(finishedIdx);
  });
});
