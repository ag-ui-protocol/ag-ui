import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@ag-ui/client", () => {
  class AbstractAgent {
    constructor(_config?: Record<string, unknown>) {}
    clone() {
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    }
  }
  return {
    AbstractAgent,
    EventType: {
      RUN_STARTED: "RUN_STARTED",
      RUN_FINISHED: "RUN_FINISHED",
      RUN_ERROR: "RUN_ERROR",
      TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
      TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
      TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
      TOOL_CALL_START: "TOOL_CALL_START",
      TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
      TOOL_CALL_END: "TOOL_CALL_END",
      TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
      STATE_SNAPSHOT: "STATE_SNAPSHOT",
      MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
      CUSTOM: "CUSTOM",
      REASONING_START: "REASONING_START",
      REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
      REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
      REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
      REASONING_END: "REASONING_END",
      REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE",
    },
    randomUUID: () => crypto.randomUUID(),
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({})),
}));

vi.mock("@anthropic-ai/sdk/resources/beta/messages/messages", () => ({}));

import { ClaudeAgentAdapter } from "./adapter";
import { buildAguiToolMessage, processMessages } from "./utils";

async function collectPrompt(prompt: unknown): Promise<unknown> {
  if (typeof prompt === "string") return prompt;
  const messages: unknown[] = [];
  for await (const message of prompt as AsyncIterable<unknown>)
    messages.push(message);
  return messages;
}

async function runAdapter(
  messages: unknown[],
  threadId = "thread-media",
  includePartialMessages = true,
) {
  const adapter = new ClaudeAgentAdapter({
    model: "claude-haiku-4-5",
    includePartialMessages,
  });
  const events: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    adapter
      .run({
        threadId,
        runId: "run-1",
        messages,
        tools: [],
        context: [],
      } as never)
      .subscribe({
        next: (event) => events.push(event as Record<string, unknown>),
        error: reject,
        complete: resolve,
      });
  });
  return events;
}

describe("ClaudeAgentAdapter multimodal input", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: vi
          .fn()
          .mockResolvedValueOnce({
            value: { type: "result", result: "ok", is_error: false },
            done: false,
          })
          .mockResolvedValueOnce({ value: undefined, done: true }),
      }),
      interrupt: vi.fn(),
    }));
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes ordered text, image, and PDF blocks to query", async () => {
    await runAdapter([
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: "describe these" },
          {
            type: "image",
            source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" },
          },
          { type: "text", text: "then read this" },
          {
            type: "document",
            source: {
              type: "data",
              value: "cGRm",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    ]);

    const prompt = queryMock.mock.calls[0][0].prompt;
    await expect(collectPrompt(prompt)).resolves.toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe these" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aW1hZ2U=",
              },
            },
            { type: "text", text: "then read this" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "cGRm",
              },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "thread-media",
      },
    ]);
  });

  it("maps supported remote image and PDF URLs", async () => {
    const { userMessage } = processMessages({
      threadId: "thread-url",
      messages: [
        {
          id: "1",
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", value: "https://example.com/image.png" },
            },
            {
              type: "document",
              source: {
                type: "url",
                value: "https://example.com/file.pdf",
                mimeType: "application/pdf",
              },
            },
          ],
        },
      ],
    } as never);

    const messages = (await collectPrompt(userMessage)) as Array<
      Record<string, any>
    >;
    expect(messages[0].message.content).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/image.png" },
      },
      {
        type: "document",
        source: { type: "url", url: "https://example.com/file.pdf" },
      },
    ]);
  });

  it.each(["audio", "video"])(
    "skips unsupported %s blocks with a warning instead of throwing",
    async (type) => {
      const warn = vi.mocked(console.warn);
      const { userMessage } = processMessages({
        threadId: "thread-unsupported",
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type,
                source: {
                  type: "data",
                  value: "Ynl0ZXM=",
                  mimeType: `${type}/mp4`,
                },
              },
            ],
          },
        ],
      } as never);

      expect(await collectPrompt(userMessage)).toEqual([
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "what is this?" }],
          },
          parent_tool_use_id: null,
          session_id: "thread-unsupported",
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        `Dropping content[1] of type ${type}`,
      );
    },
  );

  it("rejects opaque binary ids instead of dropping them", () => {
    expect(() =>
      processMessages({
        threadId: "thread-file",
        messages: [
          {
            id: "1",
            role: "user",
            content: [
              { type: "binary", mimeType: "image/png", id: "file-123" },
            ],
          },
        ],
      } as never),
    ).toThrow("opaque file id");
  });

  it.each([
    {
      name: "image data",
      block: { type: "binary", mimeType: "image/png", data: "aW1hZ2U=" },
      expected: {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
      },
    },
    {
      name: "image URL",
      block: {
        type: "binary",
        mimeType: "image/png",
        url: "https://example.com/image.png",
      },
      expected: {
        type: "image",
        source: { type: "url", url: "https://example.com/image.png" },
      },
    },
    {
      name: "PDF data",
      block: { type: "binary", mimeType: "application/pdf", data: "cGRm" },
      expected: {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
      },
    },
    {
      name: "PDF URL",
      block: {
        type: "binary",
        mimeType: "application/pdf",
        url: "https://example.com/file.pdf",
      },
      expected: {
        type: "document",
        source: { type: "url", url: "https://example.com/file.pdf" },
      },
    },
  ])("preserves legacy binary $name input", async ({ block, expected }) => {
    await runAdapter([{ id: "1", role: "user", content: [block] }]);

    await expect(
      collectPrompt(queryMock.mock.calls[0][0].prompt),
    ).resolves.toEqual([
      {
        type: "user",
        message: { role: "user", content: [expected] },
        parent_tool_use_id: null,
        session_id: "thread-media",
      },
    ]);
  });

  it("declares protocolVersion 1.0 on RUN_STARTED", async () => {
    const events = await runAdapter([
      { id: "1", role: "user", content: "hello" },
    ]);

    const started = events.filter((event) => event.type === "RUN_STARTED");
    expect(started).toHaveLength(1);
    expect(started[0].protocolVersion).toBe("1.0");
  });

  it("emits AG-UI error events when adapter input conversion fails", async () => {
    const events = await runAdapter([
      {
        id: "1",
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "data",
              value: "Ynl0ZXM=",
              mimeType: "image/tiff",
            },
          },
        ],
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
    expect(events[1].message).toContain("mimeType");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not send empty text blocks to query", async () => {
    await runAdapter([
      {
        id: "1",
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
      },
    ]);

    expect(queryMock.mock.calls[0][0].prompt).toBe("");
  });

  it("keeps plain string prompts unchanged", async () => {
    await runAdapter(
      [{ id: "1", role: "user", content: "hello" }],
      "thread-text",
    );

    expect(queryMock.mock.calls[0][0].prompt).toBe("hello");
  });

  it("rejects a historical frontend reply without a saved SDK deferral", async () => {
    const events = await runAdapter(
      [
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
        { id: "t1", role: "tool", toolCallId: "call-1", content: "" },
      ],
      "thread-follow-up",
    );

    expect(queryMock).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toContain("RUN_ERROR");
    expect(events.map((event) => event.type)).not.toContain("RUN_FINISHED");
  });
  // A `file` source names bytes already held by a model provider, under a
  // handle only that provider can resolve. The Claude Agent SDK adapter has no
  // way to forward one, and the specification's rule for a part a producer
  // cannot use is to skip it and continue — not to fail the run, which is what
  // the "must be data or url" throw used to do.
  it("drops a file-sourced document part, keeps the text, and warns", async () => {
    const warn = vi.spyOn(console, "warn");
    const events = await runAdapter(
      [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "read this" },
            {
              type: "document",
              source: {
                type: "file",
                value: "file-abc123",
                provider: "anthropic",
                mimeType: "application/pdf",
              },
            },
          ],
        },
      ],
      "thread-file",
    );

    // Nothing threw: the run reached its normal end rather than RUN_ERROR.
    expect(events.map((event) => event.type)).not.toContain("RUN_ERROR");

    const prompt = queryMock.mock.calls[0][0].prompt;
    await expect(collectPrompt(prompt)).resolves.toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "read this" }],
        },
        parent_tool_use_id: null,
        session_id: "thread-file",
      },
    ]);
    // The handle never leaves as a URL or any other block.
    expect(JSON.stringify(await collectPrompt(prompt))).not.toContain(
      "file-abc123",
    );

    const warned = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warned).toContain("document");
    expect(warned).toMatch(/file handle/i);
  });

  it("drops a file-sourced image part rather than sending it as a URL", async () => {
    const warn = vi.spyOn(console, "warn");
    await runAdapter(
      [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: {
                type: "file",
                value: "file-img",
                mimeType: "image/png",
              },
            },
          ],
        },
      ],
      "thread-file-image",
    );

    const prompt = await collectPrompt(queryMock.mock.calls[0][0].prompt);
    expect(JSON.stringify(prompt)).not.toContain("file-img");
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "image",
    );
  });

  it("preserves tool-result media as structured JSON", () => {
    const blocks = [
      { type: "text", text: "chart attached" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "eA==" },
      },
    ];
    expect(buildAguiToolMessage("tc1", blocks).content).toMatchObject([
      { type: "text", text: "chart attached" },
      {
        type: "image",
        source: { type: "data", value: "eA==", mimeType: "image/png" },
      },
    ]);
  });

  it("does not warn for text-only results", () => {
    const warn = vi.mocked(console.warn);
    buildAguiToolMessage("tc1", [{ type: "text", text: "ok" }]);
    buildAguiToolMessage("tc1", "ok");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("SDK content identity", () => {
  it("keeps one native message and all emitted content", async () => {
    const content = [
      { type: "text", text: "Hi" },
      { type: "thinking", thinking: "reason", signature: "sig" },
      { type: "future_block", payload: [1, 2] },
    ];
    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg-native" } },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hi" },
          },
        };
        yield { type: "stream_event", event: { type: "message_stop" } };
        yield {
          type: "assistant",
          uuid: "record-native",
          message: { id: "msg-native", content },
        };
      })(),
    );
    const events = await runAdapter([]);
    expect(
      events.find((e) => e.type === "MESSAGES_SNAPSHOT")?.messages,
    ).toEqual([{ id: "msg-native", role: "assistant", content: "Hi" }]);
    expect(
      events.find((e) => e.name === "claude:assistant_content")?.value,
    ).toMatchObject({
      messageId: "msg-native",
      uuid: "record-native",
      content,
    });
  });
  it("retains unsupported input media and filenames in the recorded input", async () => {
    queryMock.mockImplementation(() => (async function* () {})());
    const messages = [
      {
        id: "user-native",
        role: "user",
        content: [
          { type: "text", text: "Hi" },
          {
            type: "audio",
            source: { type: "data", mimeType: "audio/wav", value: "AQID" },
            metadata: { filename: "speech.wav" },
          },
        ],
      },
    ];
    const events = await runAdapter(messages);
    expect(
      events.find((e) => e.name === "claude:unsupported_input")?.value,
    ).toMatchObject({
      messageId: "user-native",
      contentIndex: 1,
      contentType: "audio",
    });
    expect(events.find((e) => e.type === "RUN_STARTED")?.input).toMatchObject({
      messages,
    });
  });
});

it("forwards UTF-8 text documents with their filename", async () => {
  const prompt = processMessages({
    threadId: "thread",
    runId: "run",
    messages: [
      {
        id: "user",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "data", value: "aMOpbGxv", mimeType: "text/plain" },
            metadata: { filename: "notes.txt" },
          },
        ],
      },
    ],
    tools: [],
    context: [],
    state: {},
  }).userMessage;
  expect(await collectPrompt(prompt)).toMatchObject([
    {
      message: {
        content: [
          {
            type: "document",
            title: "notes.txt",
            source: { type: "text", media_type: "text/plain", data: "héllo" },
          },
        ],
      },
    },
  ]);
});

it("retains the native structured tool result and record identity", async () => {
  const result = {
    structuredContent: { chart: [1, 2] },
    _meta: { ui: { resourceUri: "ui://chart" } },
  };
  queryMock.mockImplementation(() =>
    (async function* () {
      yield {
        type: "user",
        uuid: "record-original",
        tool_use_result: result,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "original", content: "ok" },
          ],
        },
      };
    })(),
  );
  const events = await runAdapter([]);
  expect(
    events.find((e) => e.type === "TOOL_CALL_RESULT")?.rawEvent,
  ).toMatchObject({ uuid: "record-original", tool_use_result: result });
});

it.each([false, true])(
  "accumulates native assistant records with partial messages=%s",
  async (partial) => {
    for (const second of [
      { type: "text", text: "Second segment." },
      {
        type: "tool_use",
        id: "weather-call",
        name: "mcp__weather__get_weather",
        input: { location: "Paris" },
      },
    ]) {
      queryMock.mockImplementation(() =>
        (async function* () {
          if (partial) {
            yield {
              type: "stream_event",
              event: { type: "message_start", message: { id: "multi-native" } },
            };
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "First segment." },
              },
            };
          }
          yield {
            type: "assistant",
            uuid: "record-first",
            message: {
              id: "multi-native",
              content: [{ type: "text", text: "First segment." }],
            },
          };
          if (partial && second.type === "text")
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: second.text },
              },
            };
          yield {
            type: "assistant",
            uuid: "record-second",
            message: { id: "multi-native", content: [second] },
          };
          if (partial)
            yield { type: "stream_event", event: { type: "message_stop" } };
        })(),
      );
      const events = await runAdapter([], "thread-media", partial);
      const snapshot = events.find((e) => e.type === "MESSAGES_SNAPSHOT");
      expect(snapshot?.messages).toHaveLength(1);
      expect(snapshot?.messages).toMatchObject([
        {
          id: "multi-native",
          content:
            second.type === "text"
              ? "First segment.Second segment."
              : "First segment.",
        },
      ]);
      if (second.type === "tool_use")
        expect(snapshot?.messages).toMatchObject([
          {
            toolCalls: [
              {
                id: "weather-call",
                function: { name: "mcp__weather__get_weather" },
              },
            ],
          },
        ]);
    }
  },
);
