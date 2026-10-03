import { BaseEvent, EventType } from "@ag-ui/core";
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
