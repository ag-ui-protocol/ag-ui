import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@ag-ui/client";
import { convertMessages } from "@mastra/core/agent";
import { convertAGUIMessagesToMastra } from "../utils";

function toolPair(id: string, args: string) {
  return [
    {
      id: `assistant-${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        { id, type: "function", function: { name: "search", arguments: args } },
      ],
    },
    {
      id: `result-${id}`,
      role: "tool",
      toolCallId: id,
      content: "found record 42",
    },
  ] satisfies [Message, Message];
}

describe("replayed tool-call/result pairing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops an irreparable call and result while preserving sibling pairs and text", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [badCall, badResult] = toolPair("bad", "not-json");
    const [goodCall, goodResult] = toolPair("good", '{"q":"ok"}');
    const messages: Message[] = [
      {
        ...badCall,
        content: "still usable",
        toolCalls: [
          ...(badCall.toolCalls ?? []),
          ...(goodCall.toolCalls ?? []),
        ],
      },
      badResult,
      goodResult,
      { id: "next", role: "user", content: "continue" },
    ];
    const expected = convertAGUIMessagesToMastra([
      { ...badCall, content: "still usable", toolCalls: goodCall.toolCalls },
      goodResult,
      messages[3],
    ]);
    const converted = convertAGUIMessagesToMastra(messages);
    expect(converted).toEqual(expected);
    // Mastra otherwise reconstructs the orphaned result's call with {} args.
    expect(convertMessages(converted).to("AIV5.Model")).toEqual(
      convertMessages(expected).to("AIV5.Model"),
    );
  });

  it("omits an assistant message emptied by skipping its only call", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const next: Message = { id: "next", role: "user", content: "continue" };
    expect(
      convertAGUIMessagesToMastra([...toolPair("bad", "not-json"), next]),
    ).toEqual([next]);
  });

  it("preserves a result-only continuation even when lookup history has malformed args", () => {
    const history = toolPair("stored", "not-json");
    expect(convertAGUIMessagesToMastra([history[1]], history)).toEqual([
      {
        id: "result-stored",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "stored",
            toolName: "search",
            result: "found record 42",
            isError: false,
          },
        ],
      },
    ]);
  });

  it.each(['{"q":"ok"}{"q":"ok"}', "   "])(
    "preserves the result when call arguments can be recovered: %s",
    (args) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const converted = convertAGUIMessagesToMastra(toolPair("kept", args));
      expect(converted).toHaveLength(2);
      expect(converted[1]).toMatchObject({
        role: "tool",
        content: [{ toolCallId: "kept" }],
      });
    },
  );
});
