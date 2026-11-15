import { BaseEvent, EventType, type ToolCallStartEvent } from "@ag-ui/core";
import { firstValueFrom, from } from "rxjs";
import { toArray } from "rxjs/operators";
import { compactEvents } from "../compact";
import { verifyEvents } from "../../verify/verify";

async function verify(events: BaseEvent[]) {
  return firstValueFrom(from(events).pipe(verifyEvents(false), toArray()));
}

describe("compaction at run terminal boundaries", () => {
  it("keeps an incomplete tool call before RUN_ERROR", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "edit",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: '{"path":',
      },
      {
        type: EventType.RUN_ERROR,
        message: "aborted",
        code: "ABORTED",
      },
    ];

    // The original aborted run is verifier-acceptable.
    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);

    expect(compacted.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.RUN_ERROR,
    ]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  it("keeps an incomplete assistant message before RUN_ERROR", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r2" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-1",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "half a sentence",
      },
      {
        type: EventType.RUN_ERROR,
        message: "aborted",
        code: "ABORTED",
      },
    ];

    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);

    expect(compacted.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.RUN_ERROR,
    ]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  for (const firstKind of ["tool", "text"] as const) {
    for (const withTerminal of [true, false]) {
      it(`preserves ${firstKind}-first pending stream order ${withTerminal ? "at RUN_ERROR" : "at end of input"}`, async () => {
        const toolEvents: BaseEvent[] = [
          { type: EventType.TOOL_CALL_START, toolCallId: "call-mixed", toolCallName: "edit" },
          { type: EventType.TOOL_CALL_ARGS, toolCallId: "call-mixed", delta: '{"path":' },
        ];
        const textEvents: BaseEvent[] = [
          { type: EventType.TEXT_MESSAGE_START, messageId: "message-mixed", role: "assistant" },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "message-mixed", delta: "working" },
        ];
        const streams = firstKind === "tool"
          ? [...toolEvents, ...textEvents]
          : [...textEvents, ...toolEvents];
        const events: BaseEvent[] = [
          { type: EventType.RUN_STARTED, threadId: "t", runId: "r-mixed" },
          ...streams,
          ...(withTerminal
            ? [{ type: EventType.RUN_ERROR, message: "aborted", code: "ABORTED" } as BaseEvent]
            : []),
        ];

        const compacted = compactEvents(events);
        expect(compacted.map((event) => event.type)).toEqual(
          events.map((event) => event.type),
        );

        if (withTerminal) {
          // RUN_ERROR can follow incomplete streams. An open stream before
          // RUN_FINISHED is not verifier-valid input, so it is not synthesized.
          await expect(verify(events)).resolves.toHaveLength(events.length);
          await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
        }
      });
    }
  }

  it("flushes two unfinished tool calls in opening order before RUN_ERROR", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r-parallel" },
      { type: EventType.TOOL_CALL_START, toolCallId: "first", toolCallName: "search" },
      { type: EventType.TOOL_CALL_START, toolCallId: "second", toolCallName: "edit" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "second", delta: '{"path":' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "first", delta: '{"q":' },
      { type: EventType.RUN_ERROR, message: "aborted", code: "ABORTED" },
    ];

    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);
    expect(compacted.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.RUN_ERROR,
    ]);
    // Both streams have the same event types: check IDs, not just types.
    expect(
      compacted
        .filter((event) => event.type === EventType.TOOL_CALL_START)
        .map((event) => (event as ToolCallStartEvent).toolCallId),
    ).toEqual(["first", "second"]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  it("drops a closed stream from the pending order without losing an open tool call", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r-prune" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" },
      { type: EventType.TOOL_CALL_START, toolCallId: "still-open", toolCallName: "edit" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "still-open", delta: "{" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" },
      { type: EventType.RUN_ERROR, message: "aborted", code: "ABORTED" },
    ];

    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);
    expect(compacted.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.RUN_ERROR,
    ]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  it("keeps a fully closed run verifier-readable after normal stream reordering", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r-finished" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "done" },
      { type: EventType.TOOL_CALL_START, toolCallId: "tool", toolCallName: "search" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "tool" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "m" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r-finished" },
    ];

    await expect(verify(events)).resolves.toHaveLength(events.length);

    const compacted = compactEvents(events);
    // The completed tool call flushes before the text group: that preexisting
    // reordering is legal, unlike moving either stream past the run terminal.
    expect(compacted.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    await expect(verify(compacted)).resolves.toHaveLength(compacted.length);
  });

  it("rejects an unfinished stream at RUN_FINISHED before compaction", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r-unfinished" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta: "unfinished" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r-unfinished" },
    ];
    // Only RUN_ERROR permits unfinished streams in verifier-valid input.
    await expect(verify(events)).rejects.toThrow();
  });

  it("keeps replayed later runs verifier-readable after an aborted stream", async () => {
    const aborted = compactEvents([
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "edit",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: "{",
      },
      {
        type: EventType.RUN_ERROR,
        message: "aborted",
        code: "ABORTED",
      },
    ] as BaseEvent[]);

    const nextRun: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r2" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "message-2",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-2",
        delta: "recovered",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "message-2" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r2" },
    ];

    const replay = compactEvents([...aborted, ...nextRun]);

    expect(replay.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    await expect(verify(replay)).resolves.toHaveLength(replay.length);
  });
});
