import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { streamLangChainResponse } from "../streaming";

// A minifying bundler (e.g. a Next.js production server build) renames
// LangChain's classes, so `constructor.name` is no longer "AIMessageChunk".
// Subclasses with other names reproduce that without a bundler.
class t extends AIMessageChunk {}
class e extends AIMessage {}

/** Minimal stand-in for an IterableReadableStream of chunks. */
function fakeStream(chunks: unknown[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined },
      releaseLock: () => {},
    }),
  };
}

async function collect(gen: AsyncGenerator<BaseEvent>): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("streamLangChainResponse with renamed (minified) LangChain classes", () => {
  it("still emits a streamed tool call", async () => {
    const chunks = [
      new t({
        content: "",
        tool_call_chunks: [
          { id: "call_1", name: "change_background", args: '{"background":"blue"', index: 0 },
        ],
      }),
      new t({ content: "", tool_call_chunks: [{ args: "}", index: 0 }] }),
    ];

    const events = await collect(streamLangChainResponse(fakeStream(chunks) as never));

    expect(events.map((ev) => ev.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    expect(events[0]).toMatchObject({ toolCallName: "change_background" });
  });

  it("still emits the tool calls of a complete AI message", async () => {
    const message = new e({
      content: "",
      tool_calls: [{ id: "call_1", name: "change_background", args: { background: "blue" } }],
    });

    const events = await collect(streamLangChainResponse(message));

    expect(events.map((ev) => ev.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
  });
});
