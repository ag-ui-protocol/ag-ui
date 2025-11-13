import type { Message } from "@ag-ui/client";
import { toMastraTextContent, convertAGUIMessagesToMastra } from "./utils";

describe("toMastraTextContent", () => {
  it("returns empty string for null content", () => {
    expect(toMastraTextContent(null as any)).toBe("");
  });

  it("returns empty string for undefined content", () => {
    expect(toMastraTextContent(undefined as any)).toBe("");
  });

  it("returns string content as-is", () => {
    expect(toMastraTextContent("Hello world")).toBe("Hello world");
  });

  it("returns empty string for non-array, non-string content", () => {
    expect(toMastraTextContent({} as any)).toBe("");
    expect(toMastraTextContent(123 as any)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(toMastraTextContent([])).toBe("");
  });

  it("extracts and joins text parts with newline", () => {
    const content = [
      { type: "text" as const, text: "Hello" },
      { type: "text" as const, text: "World" },
    ];
    expect(toMastraTextContent(content)).toBe("Hello\nWorld");
  });

  it("filters out non-text parts", () => {
    const content = [
      { type: "text" as const, text: "Hello" },
      { type: "binary" as const, mimeType: "image/png", data: "base64data" },
      { type: "text" as const, text: "World" },
    ];
    expect(toMastraTextContent(content)).toBe("Hello\nWorld");
  });

  it("trims whitespace from text parts", () => {
    const content = [
      { type: "text" as const, text: "  Hello  " },
      { type: "text" as const, text: "\nWorld\n" },
    ];
    expect(toMastraTextContent(content)).toBe("Hello\nWorld");
  });

  it("filters out empty text parts after trimming", () => {
    const content = [
      { type: "text" as const, text: "Hello" },
      { type: "text" as const, text: "   " },
      { type: "text" as const, text: "World" },
    ];
    expect(toMastraTextContent(content)).toBe("Hello\nWorld");
  });

  it("returns empty string when all text parts are whitespace", () => {
    const content = [
      { type: "text" as const, text: "   " },
      { type: "text" as const, text: "\n\n" },
    ];
    expect(toMastraTextContent(content)).toBe("");
  });
});

describe("convertAGUIMessagesToMastra", () => {
  it("returns empty array for empty input", () => {
    expect(convertAGUIMessagesToMastra([])).toEqual([]);
  });

  it("converts user message with string content", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: "Hello assistant",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "user",
        content: "Hello assistant",
      },
    ]);
  });

  it("converts user message with array content", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "user",
        content: "Hello\nWorld",
      },
    ]);
  });

  it("converts assistant message with content only", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        content: "Hi there!",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
    ]);
  });

  it("converts assistant message with tool calls only", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
        ],
      },
    ]);
  });

  it("converts assistant message with content and tool calls", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        content: "Let me check the weather",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the weather" },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
        ],
      },
    ]);
  });

  it("converts assistant message with multiple tool calls", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"NYC"}',
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: "get_time",
              arguments: "{}",
            },
          },
        ],
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
          {
            type: "tool-call",
            toolCallId: "call_2",
            toolName: "get_time",
            args: {},
          },
        ],
      },
    ]);
  });

  it("converts tool message and finds tool name from assistant message", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
      },
      {
        id: "2",
        role: "tool",
        toolCallId: "call_1",
        content: "Sunny, 72°F",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "get_weather",
            result: "Sunny, 72°F",
          },
        ],
      },
    ]);
  });

  it("converts tool message with unknown tool name when not found", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "tool",
        toolCallId: "call_unknown",
        content: "Result",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_unknown",
            toolName: "unknown",
            result: "Result",
          },
        ],
      },
    ]);
  });

  it("converts mixed conversation with user, assistant, and tool messages", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: "What's the weather?",
      },
      {
        id: "2",
        role: "assistant",
        content: "Let me check",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
      },
      {
        id: "3",
        role: "tool",
        toolCallId: "call_1",
        content: "Sunny, 72°F",
      },
      {
        id: "4",
        role: "assistant",
        content: "It's sunny and 72°F!",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "user",
        content: "What's the weather?",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "get_weather",
            result: "Sunny, 72°F",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "It's sunny and 72°F!" }],
      },
    ]);
  });

  it("ignores non-user, non-assistant, non-tool messages", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: "Hello",
      },
      {
        id: "2",
        role: "system",
        content: "System message",
      } as any,
      {
        id: "3",
        role: "assistant",
        content: "Hi",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "user",
        content: "Hello",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
    ]);
  });

  it("handles assistant message with empty content and no tool calls", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [],
      },
    ]);
  });

  it("handles tool message lookup across multiple assistant messages", () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "assistant",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "tool_a",
              arguments: "{}",
            },
          },
        ],
      },
      {
        id: "2",
        role: "assistant",
        toolCalls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "tool_b",
              arguments: "{}",
            },
          },
        ],
      },
      {
        id: "3",
        role: "tool",
        toolCallId: "call_2",
        content: "result",
      },
    ];

    const result = convertAGUIMessagesToMastra(messages);
    expect(result[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "tool_b",
          result: "result",
        },
      ],
    });
  });
});
