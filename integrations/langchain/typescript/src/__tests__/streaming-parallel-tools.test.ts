import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { AIMessageChunk } from "@langchain/core/messages";
import { streamLangChainResponse } from "../streaming";

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

describe("streamLangChainResponse with parallel tool calls", () => {
  // Guards against the second call reusing the first call's name: the name
  // and id of each call arrive in its own first chunk (the OpenAI streaming
  // shape), and the client would run `get_weather` with `get_time`'s args.
  it("starts each streamed tool call with its own name", async () => {
    const chunks = [
      new AIMessageChunk({
        content: "",
        tool_call_chunks: [{ id: "call_a", name: "get_weather", args: "", index: 0 }],
      }),
      new AIMessageChunk({
        content: "",
        tool_call_chunks: [{ args: '{"city":"Paris"}', index: 0 }],
      }),
      new AIMessageChunk({
        content: "",
        tool_call_chunks: [{ id: "call_b", name: "get_time", args: "", index: 1 }],
      }),
      new AIMessageChunk({
        content: "",
        tool_call_chunks: [{ args: '{"tz":"CET"}', index: 1 }],
      }),
    ];

    const events = await collect(streamLangChainResponse(fakeStream(chunks) as never));

    const starts = events.filter((ev) => ev.type === EventType.TOOL_CALL_START);
    expect(starts).toMatchObject([
      { toolCallId: "call_a-idx-0", toolCallName: "get_weather" },
      { toolCallId: "call_b-idx-1", toolCallName: "get_time" },
    ]);
    expect(events.map((ev) => ev.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
  });
});
