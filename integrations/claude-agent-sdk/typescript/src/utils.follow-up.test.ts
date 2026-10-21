import { describe, expect, it, vi } from "vitest";

import { processMessages, recoveryUserMessages } from "./utils";

function followUpInput(toolContent: string) {
  return {
    threadId: "thread-follow-up",
    runId: "run-2",
    messages: [
      { id: "u1", role: "user", content: "Show me the weather card" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "showWeatherCard", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call-1",
        content: toolContent,
      },
    ],
    tools: [],
    context: [],
  } as never;
}

describe("processMessages follow-up after a frontend tool", () => {
  it("does not resume with an empty prompt when a display-only tool returns no result", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { userMessage, hasPendingToolResult } = processMessages(
      followUpInput(""),
    );

    expect(hasPendingToolResult).toBe(true);
    expect(userMessage).toBe(
      'The client completed the "showWeatherCard" tool call (id call-1) and returned no result.',
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats a whitespace-only tool result as no result", () => {
    const { userMessage } = processMessages(followUpInput("  \n"));

    expect(userMessage).toBe(
      'The client completed the "showWeatherCard" tool call (id call-1) and returned no result.',
    );
  });

  it("names the tool call id alone when no assistant message declares it", () => {
    const { userMessage } = processMessages({
      threadId: "thread-follow-up",
      runId: "run-2",
      messages: [{ id: "t1", role: "tool", toolCallId: "call-9", content: "" }],
      tools: [],
      context: [],
    } as never);

    expect(userMessage).toBe(
      "The client completed tool call call-9 and returned no result.",
    );
  });

  it("keeps a non-empty tool result as the prompt", () => {
    const { userMessage } = processMessages(followUpInput('{"ok":true}'));

    expect(userMessage).toBe('{"ok":true}');
  });
});

it("preserves ordered new users on either side of the deferred result", () => {
  const input = {
    threadId: "t",
    runId: "r",
    state: {},
    context: [],
    tools: [],
    forwardedProps: {},
    messages: [
      { id: "old", role: "user" as const, content: "Old" },
      {
        id: "call",
        role: "assistant" as const,
        toolCalls: [
          {
            id: "native",
            type: "function" as const,
            function: { name: "render", arguments: "{}" },
          },
        ],
      },
      { id: "new-1", role: "user" as const, content: "First" },
      {
        id: "result",
        role: "tool" as const,
        toolCallId: "native",
        content: "Rendered",
      },
      {
        id: "new-2",
        role: "user" as const,
        content: [{ type: "text" as const, text: "Second" }],
      },
    ],
  };
  expect(
    recoveryUserMessages(input, "native").map((message) => message.id),
  ).toEqual(["new-1", "new-2"]);
  expect(
    recoveryUserMessages(
      { ...input, messages: input.messages.slice(0, 2) },
      "native",
    ),
  ).toEqual([]);
});
