import { of, Observable, concat, EMPTY, throwError } from "rxjs";
import { toArray, catchError } from "rxjs/operators";
import { transformChunks } from "../transform";
import {
  BaseEvent,
  EventType,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  RunStartedEvent,
  RawEvent,
  RunFinishedEvent,
} from "@ag-ui/core";

describe("transformChunks", () => {
  it("should transform a single text message chunk into start, content, and end events", (done) => {
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      delta: "Hello, world!",
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(4);

      expect(events[0]).toEqual({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-123",
        role: "assistant",
      } as TextMessageStartEvent);

      expect(events[1]).toEqual({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-123",
        delta: "Hello, world!",
      } as TextMessageContentEvent);

      expect(events[2]).toEqual({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-123",
      } as TextMessageEndEvent);

      expect(events[3]).toEqual(closeEvent);

      done();
    });
  });

  it("should transform multiple text message chunks with the same ID", (done) => {
    const chunk1: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      delta: "Hello",
    };

    const chunk2: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      delta: ", world!",
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk1, chunk2), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(5);

      expect(events[0]).toEqual({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-123",
        role: "assistant",
      } as TextMessageStartEvent);

      expect(events[1]).toEqual({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-123",
        delta: "Hello",
      } as TextMessageContentEvent);

      expect(events[2]).toEqual({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-123",
        delta: ", world!",
      } as TextMessageContentEvent);

      expect(events[3]).toEqual({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-123",
      } as TextMessageEndEvent);

      expect(events[4]).toEqual(closeEvent);

      done();
    });
  });

  it("should transform a single tool call chunk into start, args, and end events", (done) => {
    const chunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tool-123",
      toolCallName: "testTool",
      delta: '{"arg1": "value1"}',
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(4);

      expect(events[0]).toEqual({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-123",
        toolCallName: "testTool",
      } as ToolCallStartEvent);

      expect(events[1]).toEqual({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-123",
        delta: '{"arg1": "value1"}',
      } as ToolCallArgsEvent);

      expect(events[2]).toEqual({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-123",
      } as ToolCallEndEvent);

      expect(events[3]).toEqual(closeEvent);

      done();
    });
  });

  it("should handle switching from text message to tool call", (done) => {
    const textChunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      delta: "Hello",
    };

    const toolChunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tool-123",
      toolCallName: "testTool",
      delta: '{"arg1": "value1"}',
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(textChunk, toolChunk), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(7);

      // Text message events
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_END);

      // Tool call events
      expect(events[3].type).toBe(EventType.TOOL_CALL_START);
      expect(events[4].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(events[5].type).toBe(EventType.TOOL_CALL_END);

      // Run finished event
      expect(events[6].type).toBe(EventType.RUN_FINISHED);

      done();
    });
  });

  it("should pass through non-chunk events", (done) => {
    const runStartEvent: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = of(runStartEvent);
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(1);
      expect(events[0]).toEqual(runStartEvent);
      done();
    });
  });

  it("should close current message when encountering a non-chunk event", (done) => {
    const textChunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      delta: "Hello",
    };

    const runStartEvent: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = of(textChunk, runStartEvent);
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(4);

      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_END);
      expect(events[3].type).toBe(EventType.RUN_STARTED);

      done();
    });
  });

  it("should handle text message chunks with different IDs", (done) => {
    const chunk1: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      delta: "Hello",
    };

    const chunk2: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-456",
      delta: "Different message",
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk1, chunk2), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(7);

      // First message
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect((events[0] as TextMessageStartEvent).messageId).toBe("msg-123");

      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((events[1] as TextMessageContentEvent).messageId).toBe("msg-123");

      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_END);
      expect((events[2] as TextMessageEndEvent).messageId).toBe("msg-123");

      // Second message
      expect(events[3].type).toBe(EventType.TEXT_MESSAGE_START);
      expect((events[3] as TextMessageStartEvent).messageId).toBe("msg-456");

      expect(events[4].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect((events[4] as TextMessageContentEvent).messageId).toBe("msg-456");

      expect(events[5].type).toBe(EventType.TEXT_MESSAGE_END);
      expect((events[5] as TextMessageEndEvent).messageId).toBe("msg-456");

      // Run finished event
      expect(events[6].type).toBe(EventType.RUN_FINISHED);

      done();
    });
  });

  it("should handle errors when first text message chunk has no ID", (done) => {
    const invalidChunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      delta: "This will fail",
    };

    const events$ = of(invalidChunk);
    const transformed$ = transformChunks(events$);

    transformed$
      .pipe(
        catchError((err) => {
          expect(err.message).toBe("First TEXT_MESSAGE_CHUNK must have a messageId");
          done();
          return EMPTY;
        }),
      )
      .subscribe({
        next: () => {
          fail("Should have thrown an error");
        },
        complete: () => {
          // Should not complete normally
        },
      });
  });

  it("should handle errors when first tool call chunk has no ID", (done) => {
    const invalidChunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      delta: "This will fail",
    };

    const events$ = of(invalidChunk);
    const transformed$ = transformChunks(events$);

    transformed$
      .pipe(
        catchError((err) => {
          expect(err.message).toBe("First TOOL_CALL_CHUNK must have a toolCallId");
          done();
          return EMPTY;
        }),
      )
      .subscribe({
        next: () => {
          fail("Should have thrown an error");
        },
        complete: () => {
          // Should not complete normally
        },
      });
  });

  it("should handle errors when first tool call chunk has no name", (done) => {
    const invalidChunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tool-123",
      delta: "This will fail",
    };

    const events$ = of(invalidChunk);
    const transformed$ = transformChunks(events$);

    transformed$
      .pipe(
        catchError((err) => {
          expect(err.message).toBe("First TOOL_CALL_CHUNK must have a toolCallName");
          done();
          return EMPTY;
        }),
      )
      .subscribe({
        next: () => {
          fail("Should have thrown an error");
        },
        complete: () => {
          // Should not complete normally
        },
      });
  });

  it("should handle tool call chunks with parentMessageId", (done) => {
    const chunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tool-123",
      toolCallName: "testTool",
      parentMessageId: "parent-msg-123",
      delta: '{"arg1": "value1"}',
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(4);

      expect(events[0]).toEqual({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-123",
        toolCallName: "testTool",
        parentMessageId: "parent-msg-123",
      } as ToolCallStartEvent);

      expect(events[1]).toEqual({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-123",
        delta: '{"arg1": "value1"}',
      } as ToolCallArgsEvent);

      expect(events[2]).toEqual({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-123",
      } as ToolCallEndEvent);

      expect(events[3]).toEqual(closeEvent);

      done();
    });
  });

  it("should pass through RAW events without transformation", (done) => {
    const rawEvent: RawEvent = {
      type: EventType.RAW,
      event: { some: "data" },
      source: "test-source",
    };

    const events$ = of(rawEvent);
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(1);
      expect(events[0]).toEqual(rawEvent);
      done();
    });
  });

  it("should handle a complex sequence of mixed events", (done) => {
    const events: BaseEvent[] = [
      // Text message chunk
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-123",
        delta: "Hello",
      } as TextMessageChunkEvent,

      // Tool call chunk
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tool-123",
        toolCallName: "testTool",
        delta: '{"arg1": "value1"}',
      } as ToolCallChunkEvent,

      // Another text message chunk
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-456",
        delta: "After tool call",
      } as TextMessageChunkEvent,

      // Non-chunk event to close the sequence
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-123",
        runId: "run-123",
      } as RunFinishedEvent,
    ];

    const events$ = of(...events);
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((result) => {
      expect(result.length).toBe(10);

      // First text message (3 events)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(result[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(result[2].type).toBe(EventType.TEXT_MESSAGE_END);

      // Tool call (3 events)
      expect(result[3].type).toBe(EventType.TOOL_CALL_START);
      expect(result[4].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(result[5].type).toBe(EventType.TOOL_CALL_END);

      // Second text message (3 events)
      expect(result[6].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(result[7].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(result[8].type).toBe(EventType.TEXT_MESSAGE_END);

      // Final event
      expect(result[9].type).toBe(EventType.RUN_FINISHED);

      done();
    });
  });

  it("should handle text message chunks without delta", (done) => {
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-123",
      // No delta property
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(3);

      expect(events[0]).toEqual({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-123",
        role: "assistant",
      } as TextMessageStartEvent);

      // No content event because there was no delta

      expect(events[1]).toEqual({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-123",
      } as TextMessageEndEvent);

      expect(events[2]).toEqual(closeEvent);

      done();
    });
  });

  it("should handle tool call chunks without delta", (done) => {
    const chunk: ToolCallChunkEvent = {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tool-123",
      toolCallName: "testTool",
      // No delta property
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(chunk), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(3);

      expect(events[0]).toEqual({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-123",
        toolCallName: "testTool",
      } as ToolCallStartEvent);

      // No args event because there was no delta

      expect(events[1]).toEqual({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-123",
      } as ToolCallEndEvent);

      expect(events[2]).toEqual(closeEvent);

      done();
    });
  });

  it("should generate exactly one start and one end event for multiple chunks with same ID", (done) => {
    // Create multiple chunks with the same message ID
    const chunks: TextMessageChunkEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-123",
        delta: "First part",
      },
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-123",
        delta: "Second part",
      },
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-123",
        delta: "Third part",
      },
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-123",
        delta: "Fourth part",
      },
    ];

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    const events$ = concat(of(...chunks), of(closeEvent));
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((events) => {
      expect(events.length).toBe(7); // 1 start + 4 content + 1 end + 1 close event

      // Count events by type
      const eventCounts = events.reduce(
        (counts, event) => {
          counts[event.type] = (counts[event.type] || 0) + 1;
          return counts;
        },
        {} as Record<EventType, number>,
      );

      // There should be exactly one start event
      expect(eventCounts[EventType.TEXT_MESSAGE_START]).toBe(1);

      // There should be exactly one end event
      expect(eventCounts[EventType.TEXT_MESSAGE_END]).toBe(1);

      // There should be exactly four content events (one for each chunk)
      expect(eventCounts[EventType.TEXT_MESSAGE_CONTENT]).toBe(4);

      // There should be exactly one run finished event
      expect(eventCounts[EventType.RUN_FINISHED]).toBe(1);

      // All content events should have the same message ID
      const contentEvents = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      ) as TextMessageContentEvent[];

      contentEvents.forEach((e) => {
        expect(e.messageId).toBe("msg-123");
      });

      // Events should be in correct order: start, content*4, end, run_finished
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[3].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[4].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[5].type).toBe(EventType.TEXT_MESSAGE_END);
      expect(events[6].type).toBe(EventType.RUN_FINISHED);

      done();
    });
  });

  it("should handle interleaved chunks with different message and tool call IDs", (done) => {
    // Create a complex sequence that alternates between different types of chunks
    const events: BaseEvent[] = [
      // First text message
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "First message part 1",
      } as TextMessageChunkEvent,

      // First tool call
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tool-1",
        toolCallName: "firstTool",
        delta: '{"arg1": "value1"}',
      } as ToolCallChunkEvent,

      // Back to first text message
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "First message part 2",
      } as TextMessageChunkEvent,

      // Second text message
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-2",
        delta: "Second message",
      } as TextMessageChunkEvent,

      // Second tool call
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tool-2",
        toolCallName: "secondTool",
        delta: '{"arg2": "value2"}',
      } as ToolCallChunkEvent,

      // Back to first tool call
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tool-1",
        toolCallName: "firstTool",
        delta: ',"arg1_more": "more data"}',
      } as ToolCallChunkEvent,

      // Non-chunk event to close the sequence
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-123",
        runId: "run-123",
      } as RunFinishedEvent,
    ];

    const events$ = of(...events);
    const transformed$ = transformChunks(events$);

    transformed$.pipe(toArray()).subscribe((results) => {
      // Count events by type
      const eventCounts = results.reduce(
        (counts, event) => {
          counts[event.type] = (counts[event.type] || 0) + 1;
          return counts;
        },
        {} as Record<EventType, number>,
      );

      // When switching between message types, the function creates new start events
      // even for previously seen message IDs
      expect(eventCounts[EventType.TEXT_MESSAGE_START]).toBe(3);
      expect(eventCounts[EventType.TOOL_CALL_START]).toBe(3);

      // There should be corresponding end events
      expect(eventCounts[EventType.TEXT_MESSAGE_END]).toBe(3);
      expect(eventCounts[EventType.TOOL_CALL_END]).toBe(3);

      // There should be 3 content events (for the text messages)
      expect(eventCounts[EventType.TEXT_MESSAGE_CONTENT]).toBe(3);

      // There should be 3 args events (for the tool calls)
      expect(eventCounts[EventType.TOOL_CALL_ARGS]).toBe(3);

      // There should be exactly one run finished event
      expect(eventCounts[EventType.RUN_FINISHED]).toBe(1);

      // Verify the total number of events
      expect(results.length).toBe(19); // 6 starts + 6 contents/args + 6 ends + 1 run finished

      // Get all messageId pairs to see start/content/end sequences
      const messageEventsById: Record<string, EventType[]> = {};

      results.forEach((event) => {
        if (
          event.type === EventType.TEXT_MESSAGE_START ||
          event.type === EventType.TEXT_MESSAGE_CONTENT ||
          event.type === EventType.TEXT_MESSAGE_END
        ) {
          const msgEvent = event as
            | TextMessageStartEvent
            | TextMessageContentEvent
            | TextMessageEndEvent;
          if (!messageEventsById[msgEvent.messageId]) {
            messageEventsById[msgEvent.messageId] = [];
          }
          messageEventsById[msgEvent.messageId].push(event.type);
        }
      });

      // Check that the first message ID appears twice
      expect(
        messageEventsById["msg-1"].filter((t: EventType) => t === EventType.TEXT_MESSAGE_START)
          .length,
      ).toBe(2);
      expect(
        messageEventsById["msg-1"].filter((t: EventType) => t === EventType.TEXT_MESSAGE_END)
          .length,
      ).toBe(2);

      // The second message ID appears only once
      expect(
        messageEventsById["msg-2"].filter((t: EventType) => t === EventType.TEXT_MESSAGE_START)
          .length,
      ).toBe(1);
      expect(
        messageEventsById["msg-2"].filter((t: EventType) => t === EventType.TEXT_MESSAGE_END)
          .length,
      ).toBe(1);

      done();
    });
  });
});
