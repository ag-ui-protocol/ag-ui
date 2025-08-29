import { from } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  EventType,
  TextMessageChunkEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunFinishedEvent,
  Role,
} from "@ag-ui/core";
import { transformChunks } from "../transform";

describe("transformChunks with roles", () => {
  const roles: Role[] = ["developer", "system", "assistant", "user", "tool"];

  it.each(roles)(
    "should preserve role '%s' when transforming text message chunks",
    (role, done) => {
      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: `msg-${role}`,
        role: role as unknown as any,
        delta: `Hello from ${role}`,
      };

      // Add a non-chunk event to close the sequence
      const closeEvent: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: "thread-123",
        runId: "run-123",
      };

      from([chunk, closeEvent])
        .pipe(transformChunks(false), toArray())
        .subscribe({
          next: (events) => {
            expect(events).toHaveLength(4); // start, content, end, run_finished

            const startEvent = events[0] as TextMessageStartEvent;
            expect(startEvent.type).toBe(EventType.TEXT_MESSAGE_START);
            expect(startEvent.messageId).toBe(`msg-${role}`);
            expect(startEvent.role).toBe(role);

            const contentEvent = events[1] as TextMessageContentEvent;
            expect(contentEvent.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
            expect(contentEvent.delta).toBe(`Hello from ${role}`);

            const endEvent = events[2] as TextMessageEndEvent;
            expect(endEvent.type).toBe(EventType.TEXT_MESSAGE_END);

            done();
          },
          error: done,
        });
    },
  );

  it("should default to 'assistant' role when chunk has no role", (done) => {
    const chunk: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-default",
      delta: "Hello default",
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    from([chunk, closeEvent])
      .pipe(transformChunks(false), toArray())
      .subscribe({
        next: (events) => {
          expect(events).toHaveLength(4);

          const startEvent = events[0] as TextMessageStartEvent;
          expect(startEvent.type).toBe(EventType.TEXT_MESSAGE_START);
          expect(startEvent.messageId).toBe("msg-default");
          expect(startEvent.role).toBe("assistant"); // default role

          done();
        },
        error: done,
      });
  });

  it("should handle multiple chunks with different roles", (done) => {
    const chunk1: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-user",
      role: "user",
      delta: "User message",
    };

    const chunk2: TextMessageChunkEvent = {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-system",
      role: "system",
      delta: "System message",
    };

    // Add a non-chunk event to close the sequence
    const closeEvent: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-123",
      runId: "run-123",
    };

    from([chunk1, chunk2, closeEvent])
      .pipe(transformChunks(false), toArray())
      .subscribe({
        next: (events) => {
          // Should have: start1, content1, end1, start2, content2, end2, run_finished
          expect(events).toHaveLength(7);

          // First message
          const start1 = events[0] as TextMessageStartEvent;
          expect(start1.type).toBe(EventType.TEXT_MESSAGE_START);
          expect(start1.messageId).toBe("msg-user");
          expect(start1.role).toBe("user");

          const content1 = events[1] as TextMessageContentEvent;
          expect(content1.delta).toBe("User message");

          // Second message
          const start2 = events[3] as TextMessageStartEvent;
          expect(start2.type).toBe(EventType.TEXT_MESSAGE_START);
          expect(start2.messageId).toBe("msg-system");
          expect(start2.role).toBe("system");

          const content2 = events[4] as TextMessageContentEvent;
          expect(content2.delta).toBe("System message");

          done();
        },
        error: done,
      });
  });
});
