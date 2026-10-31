import { EventType } from "@ag-ui/client";
import { Subscriber } from "rxjs";
import { describe, expect, it } from "vitest";

import { LangGraphAgent, type ProcessedEvents } from "./agent";
import { resolveReasoningContent } from "./utils";

describe("Google thought blocks", () => {
  it.each([undefined, 3])("recognizes a thought with index %s", (index) => {
    expect(
      resolveReasoningContent({
        chunk: {
          content: [
            {
              type: "text",
              text: "Check the constraints.",
              thought: true,
              index,
            },
          ],
        },
      }),
    ).toEqual({
      type: "text",
      text: "Check the constraints.",
      index: index ?? 0,
    });
  });

  it.each([undefined, false, "true"])(
    "keeps thought=%s as answer text",
    (thought) => {
      expect(
        resolveReasoningContent({
          chunk: { content: [{ type: "text", text: "213", thought }] },
        }),
      ).toBeNull();
    },
  );

  it("does not open reasoning for an empty thought", () => {
    expect(
      resolveReasoningContent({
        chunk: { content: [{ type: "text", text: "", thought: true }] },
      }),
    ).toBeNull();
  });

  it("streams thoughts separately from the answer and closes the reasoning span", () => {
    const agent = new LangGraphAgent({
      graphId: "test-graph",
      deploymentUrl: "http://localhost:8000",
      emitRawEvents: false,
    });
    const events: ProcessedEvents[] = [];
    agent.subscriber = new Subscriber<ProcessedEvents>({
      next: (event: ProcessedEvents) => {
        events.push(event);
      },
      error: (error: unknown) => {
        throw error;
      },
      complete: () => {},
    });
    agent.activeRun = {
      id: "run-1",
      threadId: "thread-1",
      hasFunctionStreaming: false,
    };

    for (const content of [
      [{ type: "text", text: "Check the constraints.", thought: true }],
      [{ type: "text", text: "Verify the result.", thought: true }],
      [{ type: "text", text: "213" }],
      [],
    ]) {
      agent.handleSingleEvent({
        event: "on_chat_model_stream",
        metadata: { "emit-messages": true },
        data: {
          chunk: {
            id: "msg-1",
            content,
            tool_call_chunks: [],
            response_metadata: {},
          },
        },
      });
    }

    expect(
      events
        .filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(["Check the constraints.", "Verify the result."]);
    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(["213"]);
    const starts = events.filter(
      (event) => event.type === EventType.REASONING_START,
    );
    const ends = events.filter(
      (event) => event.type === EventType.REASONING_END,
    );
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].messageId).toBe(starts[0].messageId);
  });
});
