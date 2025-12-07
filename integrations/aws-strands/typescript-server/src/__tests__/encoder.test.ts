import { EventEncoder } from "../encoder";
import { EventType, RunFinishedEvent, RunStartedEvent } from "../types";

describe("EventEncoder", () => {
  it("defaults to server-sent events framing", () => {
    const encoder = new EventEncoder();
    const event: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: "thread-1",
      runId: "run-1",
    };

    expect(encoder.getContentType()).toBe("text/event-stream");
    expect(encoder.encode(event)).toBe(
      `data: ${JSON.stringify(event)}\n\n`
    );
  });

  it("falls back to newline-delimited JSON when SSE is not accepted", () => {
    const encoder = new EventEncoder("application/json");
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
    };

    expect(encoder.getContentType()).toBe("application/json");
    expect(encoder.encode(event)).toBe(`${JSON.stringify(event)}\n`);
  });
});
