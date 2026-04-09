/**
 * Regression tests for ag-ui-protocol/ag-ui#836
 *
 * The Mastra adapter was rotating messageId only on "finish" (end-of-run),
 * not on text-segment boundaries. This caused text chunks before and after
 * tool calls within the same run to share a single messageId, merging what
 * should be separate messages on the client side.
 *
 * The fix rotates messageId when a text segment ends — i.e., when a non-text
 * event (tool-call, tool-result, finish) arrives after text-delta events.
 */
import { EventType } from "@ag-ui/client";
import type { TextMessageChunkEvent, ToolCallStartEvent } from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

// ---------------------------------------------------------------------------
// Helper: stream chunk factories
// ---------------------------------------------------------------------------
const textDelta = (text: string) => ({
  type: "text-delta" as const,
  payload: { text },
});
const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "tool-call" as const,
  payload: { toolCallId: id, toolName: name, args },
});
const toolResult = (id: string, result: unknown) => ({
  type: "tool-result" as const,
  payload: { toolCallId: id, result },
});
const finish = () => ({
  type: "finish" as const,
  payload: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: "stop" },
});
const stepFinish = () => ({
  type: "step-finish" as const,
  payload: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: "tool-calls" },
});

// ---------------------------------------------------------------------------
// Helpers: extract text events and unique messageIds
// ---------------------------------------------------------------------------
function textChunks(events: any[]): TextMessageChunkEvent[] {
  return events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK);
}

function uniqueMessageIds(chunks: TextMessageChunkEvent[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const c of chunks) {
    if (!seen.has(c.messageId!)) {
      seen.add(c.messageId!);
      ids.push(c.messageId!);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("text-end message-id rotation (issue #836)", () => {
  describe.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ])("%s agent", (_label, makeAgent) => {
    it("text before and after a tool call get different messageIds", async () => {
      // Scenario: text → tool-call → tool-result → text → finish
      // Before the fix, both text segments shared one messageId.
      const agent = makeAgent({
        streamChunks: [
          textDelta("Before tool "),
          toolCall("tc-1", "get_weather", { city: "NYC" }),
          toolResult("tc-1", { temp: 72 }),
          textDelta("After tool"),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const chunks = textChunks(events);
      const ids = uniqueMessageIds(chunks);

      expect(chunks).toHaveLength(2);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it("consecutive text-deltas within a single segment share one messageId", async () => {
      const agent = makeAgent({
        streamChunks: [
          textDelta("Hello "),
          textDelta("world"),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const chunks = textChunks(events);
      const ids = uniqueMessageIds(chunks);

      expect(chunks).toHaveLength(2);
      expect(ids).toHaveLength(1);
    });

    it("three text segments separated by tool calls get three distinct messageIds", async () => {
      const agent = makeAgent({
        streamChunks: [
          textDelta("Segment 1"),
          toolCall("tc-1", "tool_a"),
          toolResult("tc-1", "result_a"),
          textDelta("Segment 2"),
          toolCall("tc-2", "tool_b"),
          toolResult("tc-2", "result_b"),
          textDelta("Segment 3"),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const chunks = textChunks(events);
      const ids = uniqueMessageIds(chunks);

      expect(chunks).toHaveLength(3);
      expect(ids).toHaveLength(3);
      // All three IDs must be distinct
      expect(new Set(ids).size).toBe(3);
    });

    it("tool call parentMessageId matches the preceding text segment", async () => {
      const agent = makeAgent({
        streamChunks: [
          textDelta("Let me check"),
          toolCall("tc-1", "search", { q: "test" }),
          toolResult("tc-1", "found"),
          textDelta("Here are the results"),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const firstTextChunk = events.find(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      ) as TextMessageChunkEvent;
      const toolStart = events.find(
        (e) => e.type === EventType.TOOL_CALL_START,
      ) as ToolCallStartEvent;

      // The tool call's parentMessageId should reference the preceding text
      expect(toolStart.parentMessageId).toBe(firstTextChunk.messageId);
    });

    it("tool-only run (no text) completes without errors", async () => {
      const agent = makeAgent({
        streamChunks: [
          toolCall("tc-1", "do_something"),
          toolResult("tc-1", "done"),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const chunks = textChunks(events);
      expect(chunks).toHaveLength(0);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("step-finish between steps rotates messageId correctly", async () => {
      const agent = makeAgent({
        streamChunks: [
          textDelta("Step 1 text"),
          toolCall("tc-1", "tool_a"),
          stepFinish(),
          toolResult("tc-1", "result"),
          textDelta("Step 2 text"),
          stepFinish(),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const chunks = textChunks(events);
      const ids = uniqueMessageIds(chunks);

      expect(chunks).toHaveLength(2);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it("text → tool-call (no finish between) rotates messageId before tool events", async () => {
      // This is the exact scenario from issue #836: no step-finish between
      // text and tool-call within the same step.
      const agent = makeAgent({
        streamChunks: [
          textDelta("I will look that up"),
          toolCall("tc-1", "lookup"),
          toolResult("tc-1", { data: "found" }),
          textDelta("Found it!"),
          finish(),
        ],
      });

      const events = await collectEvents(agent, makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const chunks = textChunks(events);
      const ids = uniqueMessageIds(chunks);

      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);

      // Verify the second text segment uses a NEW messageId, not the first one
      const secondChunk = chunks[1];
      expect(secondChunk.messageId).toBe(ids[1]);
      expect(secondChunk.delta).toBe("Found it!");
    });
  });
});
