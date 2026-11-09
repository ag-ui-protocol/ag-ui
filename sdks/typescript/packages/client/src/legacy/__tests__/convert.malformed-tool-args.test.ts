import { convertMessagesToLegacyFormat, convertToLegacyEvents } from "../convert";
import { of } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  AGUI_METADATA_KEY,
  BaseEvent,
  EventType,
  Message,
  MessagesSnapshotEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { LegacyRunError, LegacyRuntimeProtocolEvent } from "../types";

const messagesWithMalformedToolArgs = (): Message[] => [
  {
    id: "msg-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "broken_tool",
          // Malformed JSON as produced by a truncated / buggy server response
          arguments: '{"key": "value"',
        },
      },
    ],
  } as Message,
];

describe("convertMessagesToLegacyFormat - malformed tool call arguments (issue #2444)", () => {
  it("throws a descriptive error naming the offending tool call", () => {
    expect(() => convertMessagesToLegacyFormat(messagesWithMalformedToolArgs())).toThrow(/call-1/);
    expect(() => convertMessagesToLegacyFormat(messagesWithMalformedToolArgs())).toThrow(
      /broken_tool/,
    );
  });
});

const messagesWithAbortedToolCall = (): Message[] => [
  {
    id: "msg-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "root::inner",
        type: "function",
        function: { name: "lookup", arguments: '{"city": "Pa' },
        // Closed by a producer after a subagent failure: not work to run.
        metadata: { [AGUI_METADATA_KEY]: { aborted: true } },
      },
      {
        id: "call-ok",
        type: "function",
        function: { name: "fine_tool", arguments: '{"a": 1}' },
      },
    ],
  } as Message,
];

describe("convertMessagesToLegacyFormat - aborted tool calls", () => {
  it("leaves an aborted call out instead of throwing on its truncated arguments", () => {
    const legacy = convertMessagesToLegacyFormat(messagesWithAbortedToolCall());

    expect(legacy.map((m) => m.id)).toEqual(["call-ok"]);
  });

  it("does not surface a RunError for an aborted call in a snapshot", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: Date.now(),
        messages: messagesWithAbortedToolCall(),
      } as MessagesSnapshotEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: Date.now(),
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    expect(events.find((event) => event.type === "RunError")).toBeUndefined();
  });
});

describe("convertToLegacyEvents - malformed tool call arguments (issue #2444)", () => {
  it("surfaces a RunError on the stream instead of killing it", async () => {
    const mockEvents: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        timestamp: Date.now(),
        messages: messagesWithMalformedToolArgs(),
      } as MessagesSnapshotEvent,
      {
        type: EventType.RUN_FINISHED,
        timestamp: Date.now(),
        threadId: "test-thread",
        runId: "test-run",
      } as RunFinishedEvent,
    ];

    const events = (await convertToLegacyEvents(
      "test-thread",
      "test-run",
      "test-agent",
    )(of(...mockEvents))
      .pipe(toArray())
      .toPromise()) as LegacyRuntimeProtocolEvent[];

    const runError = events.find((event) => event.type === "RunError") as
      | LegacyRunError
      | undefined;

    expect(runError).toBeDefined();
    expect(runError!.message).toMatch(/call-1/);
    expect(runError!.message).toMatch(/broken_tool/);
  });
});
