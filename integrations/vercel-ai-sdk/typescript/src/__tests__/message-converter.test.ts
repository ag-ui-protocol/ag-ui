import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Message } from "@ag-ui/core";
import type { ModelMessage, ToolResultPart } from "ai";
import { convertMessagesToVercelAISDKMessages } from "../message-converter";

// Every conversion that loses or synthesises content warns, so console.warn is
// stubbed for the whole file: tests that care assert on it, the rest stay
// quiet. Restoring happens in afterEach rather than inline, so a failing
// expectation cannot leak the stub into the next test.
let warn: Mock<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Narrows a converted message to the output of its first tool result, so
// assertions can reach nested fields without casting.
function toolResultOutput(message: ModelMessage | undefined): ToolResultPart["output"] {
  if (message === undefined || message.role !== "tool") {
    throw new Error(`expected a tool message, got ${message?.role ?? "nothing"}`);
  }
  const part = message.content[0];
  if (part.type !== "tool-result") {
    throw new Error(`expected a tool-result part, got ${part.type}`);
  }
  return part.output;
}

describe("convertMessagesToVercelAISDKMessages", () => {
  it("returns an empty array for empty input", () => {
    expect(convertMessagesToVercelAISDKMessages([])).toEqual([]);
  });

  it("maps developer role to system", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "d1", role: "developer", content: "dev instructions" },
    ]);
    expect(result).toEqual([{ role: "system", content: "dev instructions" }]);
  });

  it("maps system role to system", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "s1", role: "system", content: "you are a helpful assistant" },
    ]);
    expect(result).toEqual([{ role: "system", content: "you are a helpful assistant" }]);
  });

  it("passes through user message with string content", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "u1", role: "user", content: "hi there" },
    ]);
    expect(result).toEqual([{ role: "user", content: "hi there" }]);
  });

  it("keeps text-only user parts as separate text parts without inserting separators", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("converts a single text part to a one-element parts array, never a bare string", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("omits a user message whose parts array is empty", () => {
    // Empty content is not something a provider will take: Anthropic rejects
    // both `[]` and `""`, so the message is left out entirely rather than sent
    // as an empty turn.
    const result = convertMessagesToVercelAISDKMessages([{ id: "u1", role: "user", content: [] }]);
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("u1"));
  });

  it("omits a user message whose string content is empty", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "u1", role: "user", content: "" },
      { id: "u2", role: "user", content: "still here" },
    ]);
    expect(result).toEqual([{ role: "user", content: "still here" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("u1"));
  });

  it("converts user image part with data source to a data URL carrying its media type", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "data", value: "AAAA", mimeType: "image/png" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,AAAA", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("forwards the media type of a URL image so providers accept it", () => {
    // OpenAI and Anthropic reject a remote image they cannot type, so a known
    // mimeType has to travel with the URL rather than being dropped.
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.com/cat.png",
              mimeType: "image/png",
            },
          },
          { type: "text", text: "describe" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "image", image: "https://example.com/cat.png", mediaType: "image/png" },
          { type: "text", text: "describe" },
        ],
      },
    ]);
  });

  it("omits the media type of a URL image when the producer did not state one", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "image", source: { type: "url", value: "https://example.com/cat.png" } },
        ],
      },
    ]);
    expect(result).toEqual([
      { role: "user", content: [{ type: "image", image: "https://example.com/cat.png" }] },
    ]);
  });

  it("converts user audio part to a file part with mediaType", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "audio",
            source: { type: "data", value: "BBBB", mimeType: "audio/mpeg" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "file", data: "data:audio/mpeg;base64,BBBB", mediaType: "audio/mpeg" },
        ],
      },
    ]);
  });

  it.each([
    ["audio", "audio"],
    ["video", "video"],
    ["document", "application"],
  ] as const)(
    "falls back to the top-level media segment for an untyped %s URL",
    (partType, expected) => {
      // FilePart.mediaType is required, so something must be sent. A top-level
      // segment fails the SDK's isFullMediaType check, which makes it adopt the
      // Content-Type it sees when downloading; "application/octet-stream" would
      // instead be taken at face value and rejected by Anthropic.
      const result = convertMessagesToVercelAISDKMessages([
        {
          id: "u1",
          role: "user",
          content: [{ type: partType, source: { type: "url", value: "https://example.com/f" } }],
        },
      ]);
      expect(result).toEqual([
        {
          role: "user",
          content: [{ type: "file", data: "https://example.com/f", mediaType: expected }],
        },
      ]);
    },
  );

  it("carries a filename from part metadata onto the file part", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "url",
              value: "https://example.com/report.pdf",
              mimeType: "application/pdf",
            },
            metadata: { filename: "report.pdf" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "https://example.com/report.pdf",
            mediaType: "application/pdf",
            filename: "report.pdf",
          },
        ],
      },
    ]);
  });

  it("ignores a non-string filename in part metadata", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "url",
              value: "https://example.com/report.pdf",
              mimeType: "application/pdf",
            },
            metadata: { filename: 42 },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "https://example.com/report.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
    ]);
  });

  it("drops a media part whose URL source carries an empty value", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "and this?" },
          { type: "image", source: { type: "url", value: "" } },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "and this?" }] }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("image"));
  });

  it("drops a media part whose data source carries no bytes", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "and this?" },
          { type: "image", source: { type: "data", value: "", mimeType: "image/png" } },
        ],
      },
    ]);
    expect(result).toEqual([{ role: "user", content: [{ type: "text", text: "and this?" }] }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("image"));
  });

  it("omits the user message when every part is dropped", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "file", value: "file-abc123", provider: "openai" },
          },
        ],
      },
    ]);
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("document"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("u1"));
  });

  it("drops a media part whose bytes live behind a provider file handle", () => {
    // A `file` source names bytes only the issuing provider can resolve. The
    // AI SDK could carry it as a provider reference, but only against a model
    // from that same provider — which the converter is not told — so the part
    // is dropped, like any part it cannot express.
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "what is in this?" },
          {
            type: "image",
            source: { type: "file", value: "file-xyz789", provider: "anthropic" },
          },
        ],
      },
    ]);
    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "what is in this?" }] },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("image"));
  });

  it("converts assistant message with content only", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "a1", role: "assistant", content: "sure" },
    ]);
    expect(result).toEqual([{ role: "assistant", content: [{ type: "text", text: "sure" }] }]);
  });

  it("converts assistant message with tool calls", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "calling tool",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "sunny" },
    ]);
    expect(result[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "calling tool" },
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "get_weather",
          input: { city: "Tokyo" },
        },
      ],
    });
  });

  it("omits an assistant message with nothing to send", () => {
    const result = convertMessagesToVercelAISDKMessages([{ id: "a1", role: "assistant" }]);
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a1"));
  });

  it("keeps an assistant message that carries only buffered reasoning", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "thinking" },
      { id: "a1", role: "assistant" },
    ]);
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
    ]);
  });

  it("back-fills an execution-denied result for an unanswered tool call", () => {
    // Without a result for every tool call the AI SDK throws
    // MissingToolResultsError while converting the prompt, which would brick
    // every later run in the conversation.
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_weather",
            output: {
              type: "execution-denied",
              reason: "No result was provided for this tool call.",
            },
          },
        ],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tc1"));
  });

  it("does not back-fill a tool call that is answered later in the history", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { id: "u1", role: "user", content: "any time now" },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "sunny" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({ role: "user", content: "any time now" });
  });

  it("back-fills only the unanswered call when an assistant turn makes two", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "sunny" },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: {} },
          { type: "tool-call", toolCallId: "tc2", toolName: "get_time", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc2",
            toolName: "get_time",
            output: {
              type: "execution-denied",
              reason: "No result was provided for this tool call.",
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_weather",
            output: { type: "text", value: "sunny" },
          },
        ],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tc2"));
  });

  it("looks up the tool name on a tool message from a prior assistant message", () => {
    const messages: Message[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "sunny" },
    ];
    const result = convertMessagesToVercelAISDKMessages(messages);
    expect(result[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "get_weather",
          output: { type: "text", value: "sunny" },
        },
      ],
    });
  });

  it("falls back to 'unknown' when the tool name lookup fails", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "t1", role: "tool", toolCallId: "ghost", content: "noop" },
    ]);
    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "ghost",
            toolName: "unknown",
            output: { type: "text", value: "noop" },
          },
        ],
      },
    ]);
  });

  it("joins text-only tool result parts into a text output", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "42" },
          { type: "text", text: " degrees" },
        ],
      },
    ]);
    expect(toolResultOutput(result[0])).toEqual({ type: "text", value: "42 degrees" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("routes a tool result that mixes text and media through the content output", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "here is the chart" },
          { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
        ],
      },
    ]);
    expect(toolResultOutput(result[0])).toEqual({
      type: "content",
      value: [
        { type: "text", text: "here is the chart" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
      ],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tc1"));
  });

  it("sends a media-only tool result as content rather than an empty text value", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
        ],
      },
    ]);
    expect(toolResultOutput(result[0])).toEqual({
      type: "content",
      value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tc1"));
  });

  it("carries a URL-sourced tool result file as tagged url file data", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          {
            type: "document",
            source: {
              type: "url",
              value: "https://example.com/report.pdf",
              mimeType: "application/pdf",
            },
            metadata: { filename: "report.pdf" },
          },
        ],
      },
    ]);
    const output = toolResultOutput(result[0]);
    if (output.type !== "content") throw new Error(`expected content output, got ${output.type}`);
    const item = output.value[0];
    if (item.type !== "file") throw new Error(`expected a file item, got ${item.type}`);
    expect(item.mediaType).toBe("application/pdf");
    expect(item.filename).toBe("report.pdf");
    if (item.data.type !== "url") throw new Error(`expected url data, got ${item.data.type}`);
    expect(item.data.url.href).toBe("https://example.com/report.pdf");
  });

  it("drops a tool result file handle even when it names a provider", () => {
    // Same rule as prompt parts: the AI SDK can carry the handle as a provider
    // reference, but resolving it against a model from a DIFFERENT provider
    // throws NoSuchProviderReferenceError and kills the whole run. The
    // converter does not know the configured provider, so it cannot tell a
    // usable handle from a fatal one — dropping (with a warning) is the only
    // safe choice until provider identity is threaded through.
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "see attachment" },
          {
            type: "document",
            source: {
              type: "file",
              value: "file-abc123",
              provider: "openai",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    ]);
    expect(toolResultOutput(result[0])).toEqual({
      type: "content",
      value: [{ type: "text", text: "see attachment" }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("document"));
  });

  it("drops a tool result file handle that names no provider", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "see attachment" },
          { type: "document", source: { type: "file", value: "file-abc123" } },
        ],
      },
    ]);
    expect(toolResultOutput(result[0])).toEqual({
      type: "content",
      value: [{ type: "text", text: "see attachment" }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("document"));
  });

  it("skips activity messages", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "ac1", role: "activity", activityType: "typing", content: { foo: "bar" } },
      { id: "u1", role: "user", content: "hi" },
    ]);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("skips reasoning messages", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "thinking..." },
      { id: "u1", role: "user", content: "hi" },
    ]);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("safely parses malformed tool-call arguments to {} instead of throwing", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "broken", arguments: "{not json" },
          },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "ok" },
    ]);
    expect(result[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc1", toolName: "broken", input: {} }],
    });
  });

  it("preserves whitespace in text-only user parts verbatim", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "  indented code\n" },
          { type: "text", text: "   " },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "  indented code\n" },
          { type: "text", text: "   " },
        ],
      },
    ]);
  });

  it("marks a failed tool result as error-text output", () => {
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: "connection refused",
        error: "connection refused",
      },
    ]);
    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "unknown",
            output: { type: "error-text", value: "connection refused" },
          },
        ],
      },
    ]);
  });

  it("falls back to the message error when a failed tool result carries only media", () => {
    // There is no error output that can carry content parts, so the media is
    // dropped — and an empty error value would tell the model nothing.
    const result = convertMessagesToVercelAISDKMessages([
      {
        id: "t1",
        role: "tool",
        toolCallId: "tc1",
        content: [
          { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
        ],
        error: "screenshot failed",
      },
    ]);
    expect(toolResultOutput(result[0])).toEqual({
      type: "error-text",
      value: "screenshot failed",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tc1"));
  });

  it("attaches a reasoning message (with signature) to the following assistant message", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "thinking hard", encryptedValue: "sig-abc" },
      { id: "a1", role: "assistant", content: "the answer" },
    ]);
    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking hard",
            providerOptions: { anthropic: { signature: "sig-abc" } },
          },
          { type: "text", text: "the answer" },
        ],
      },
    ]);
  });

  it("attaches a reasoning message without signature as a plain reasoning part", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "brief thought" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { id: "t1", role: "tool", toolCallId: "tc1", content: "sunny" },
    ]);
    expect(result[0]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "brief thought" },
        { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: {} },
      ],
    });
  });

  it("drops buffered reasoning when a non-assistant message follows", () => {
    const result = convertMessagesToVercelAISDKMessages([
      { id: "r1", role: "reasoning", content: "stale thought" },
      { id: "u1", role: "user", content: "actually, nevermind" },
      { id: "a1", role: "assistant", content: "ok" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "actually, nevermind" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
  });
});
