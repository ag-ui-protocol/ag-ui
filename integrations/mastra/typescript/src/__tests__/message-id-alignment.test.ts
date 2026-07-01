import { EventType } from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

/**
 * Regression tests for OSS-105: the bridge must stream the assistant message
 * under the id Mastra announces on the start / step-start chunk (the id Mastra
 * persists), not a freshly minted randomUUID. Otherwise the id the client sees
 * differs from the stored id, and re-sent history on the next turn fails to
 * dedupe, duplicating the assistant message in storage.
 */
describe("assistant message id alignment", () => {
  it("adopts the start chunk's messageId for streamed text", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-msg-1" } },
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const chunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    expect(chunk).toBeDefined();
    expect(chunk.messageId).toBe("mastra-msg-1");
  });

  it("adopts the step-start messageId and applies it to a tool call's parentMessageId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: "mastra-msg-2" } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "call-1",
            toolName: "get_weather",
            args: { city: "NYC" },
          },
        },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const start = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;

    expect(start).toBeDefined();
    expect(start.parentMessageId).toBe("mastra-msg-2");
  });

  it("uses a new messageId per step when step-start announces a new id", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-msg-A" } },
        { type: "text-delta", payload: { text: "first" } },
        { type: "step-finish", payload: {} },
        { type: "step-start", payload: { messageId: "mastra-msg-B" } },
        { type: "text-delta", payload: { text: "second" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const ids = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    expect(ids).toContain("mastra-msg-A");
    expect(ids).toContain("mastra-msg-B");
  });

  it("falls back to a generated id when no start messageId is provided", async () => {
    // Remote/older streams may omit the start messageId. The bridge must still
    // emit a valid, stable messageId so the stream is well-formed.
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const chunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    expect(chunk).toBeDefined();
    expect(typeof chunk.messageId).toBe("string");
    expect(chunk.messageId.length).toBeGreaterThan(0);
  });
});
