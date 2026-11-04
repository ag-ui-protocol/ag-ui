import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, ContentPart, Message, Tool } from "@ag-ui/client";
import { ToolCallResultEventSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { createTool } from "@mastra/core/tools";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { z } from "zod";
import {
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeProviderFetch,
  makeRemoteMastraAgent,
  toolResultsInBody,
} from "./helpers";
import type { ProviderRequest } from "./helpers";
import { MastraAgent } from "../mastra";
import { contentPartsToModelOutput } from "../tool-results";
import { convertAGUIMessagesToMastra } from "../utils";

// Tool results as AG-UI content parts. Mastra keeps what the model sees of a
// result (a tool's `toModelOutput`) as `providerMetadata.mastra.modelOutput`;
// its content form maps onto content parts in both directions.

const PNG = "iVBORw0KGgo=";

function resultChunk(result: unknown, modelOutput?: unknown) {
  return {
    type: "tool-result",
    payload: {
      toolCallId: "tc-1",
      toolName: "snapshot",
      result,
      ...(modelOutput !== undefined
        ? { providerMetadata: { mastra: { modelOutput } } }
        : {}),
    },
  };
}

const callChunk = {
  type: "tool-call",
  payload: { toolCallId: "tc-1", toolName: "snapshot", args: {} },
};

function resultContent(events: BaseEvent[]) {
  const event = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  expect(() => ToolCallResultEventSchema.parse(event)).not.toThrow();
  return (event as any).content;
}

describe.each([
  ["local", makeLocalMastraAgent],
  ["remote", makeRemoteMastraAgent],
] as const)("TOOL_CALL_RESULT content (%s)", (_kind, makeAgent) => {
  it("emits content parts for a tool whose model output is the content form", async () => {
    const agent = makeAgent({
      streamChunks: [
        callChunk,
        resultChunk(
          { raw: true },
          {
            type: "content",
            value: [
              { type: "text", text: "Screenshot taken." },
              { type: "media", data: PNG, mediaType: "image/png" },
            ],
          },
        ),
      ],
    });
    const events = await collectEvents(agent, makeInput());

    expect(resultContent(events)).toEqual([
      { type: "text", text: "Screenshot taken." },
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
      },
    ]);
  });

  it("keeps the serialized result when the model output is not content", async () => {
    const agent = makeAgent({
      streamChunks: [
        callChunk,
        resultChunk({ temp: 21 }, { type: "json", value: { temp: 21 } }),
      ],
    });
    const events = await collectEvents(agent, makeInput());

    expect(resultContent(events)).toBe(JSON.stringify({ temp: 21 }));
  });

  it("keeps the serialized result when there is no model output", async () => {
    const agent = makeAgent({
      streamChunks: [callChunk, resultChunk({ temp: 21 })],
    });
    const events = await collectEvents(agent, makeInput());

    expect(resultContent(events)).toBe(JSON.stringify({ temp: 21 }));
  });

  it("emits the empty string for a tool that returns nothing", async () => {
    const agent = makeAgent({
      streamChunks: [callChunk, resultChunk(undefined)],
    });
    const events = await collectEvents(agent, makeInput());

    expect(resultContent(events)).toBe("");
  });
});

describe("TOOL_CALL_RESULT content: results JSON cannot hold", () => {
  async function contentFor(result: unknown) {
    const agent = makeLocalMastraAgent({
      streamChunks: [callChunk, resultChunk(result)],
    });
    return resultContent(await collectEvents(agent, makeInput()));
  }

  it("emits the empty string for a function result", async () => {
    expect(await contentFor(() => 1)).toBe("");
  });

  it("emits a string, with a warning, for a result JSON.stringify throws on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(await contentFor(BigInt(10))).toBe("10");
    expect(typeof (await contentFor(circular))).toBe("string");
    const serializeWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes("not JSON-serializable"),
    );
    expect(serializeWarnings).toHaveLength(2);
    warn.mockRestore();
  });
});

describe("TOOL_CALL_RESULT content: the model output item forms", () => {
  async function contentFor(value: unknown[]) {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        callChunk,
        resultChunk({ raw: true }, { type: "content", value }),
      ],
    });
    return resultContent(await collectEvents(agent, makeInput()));
  }

  it("reads a URL or data URI Mastra put where media data goes", async () => {
    expect(
      await contentFor([
        {
          type: "media",
          data: "https://example.com/a.png",
          mediaType: "image/png",
        },
        { type: "media", data: `data:audio/wav;base64,UklG`, mediaType: "" },
      ]),
    ).toEqual([
      {
        type: "image",
        source: {
          type: "url",
          value: "https://example.com/a.png",
          mimeType: "image/png",
        },
      },
      {
        type: "audio",
        source: { type: "data", value: "UklG", mimeType: "audio/wav" },
      },
    ]);
  });

  it("base64-encodes the payload of a data URI that is not base64", async () => {
    const base64 = (text: string) =>
      Buffer.from(text, "utf8").toString("base64");
    expect(
      await contentFor([
        {
          type: "media",
          data: "data:text/plain,hello%20world",
          mediaType: "text/plain",
        },
        {
          type: "media",
          data: "data:image/svg+xml;charset=utf-8,<svg/>%E2%9C%93é",
          mediaType: "image/svg+xml",
        },
        { type: "media", data: "data:,hi" },
      ]),
    ).toEqual([
      {
        type: "document",
        source: {
          type: "data",
          value: base64("hello world"),
          mimeType: "text/plain",
        },
      },
      {
        type: "image",
        source: {
          type: "data",
          value: base64("<svg/>✓é"),
          mimeType: "image/svg+xml",
        },
      },
      {
        type: "document",
        source: { type: "data", value: base64("hi"), mimeType: "text/plain" },
      },
    ]);
  });

  it("reads a base64 data URI whose payload is percent-encoded or wrapped", async () => {
    expect(
      await contentFor([
        {
          type: "media",
          data: "data:image/png;BASE64,iVBORw0K%0AGgo%3D",
          mediaType: "image/png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
      },
    ]);
  });

  it("emits a URL in media data as a url source, without inventing a media type", async () => {
    expect(
      await contentFor([
        { type: "media", data: "https://example.com/a.png" },
        { type: "media", data: "s3://bucket/b.png", mediaType: "image/png" },
      ]),
    ).toEqual([
      {
        type: "document",
        source: { type: "url", value: "https://example.com/a.png" },
      },
      {
        type: "image",
        source: {
          type: "url",
          value: "s3://bucket/b.png",
          mimeType: "image/png",
        },
      },
    ]);
  });

  it("keeps an image-data item an image when it has no media type", async () => {
    expect(
      await contentFor([
        { type: "image-data", data: PNG },
        { type: "image-data", data: "https://example.com/c" },
      ]),
    ).toEqual([
      {
        type: "image",
        source: {
          type: "data",
          value: PNG,
          mimeType: "application/octet-stream",
        },
      },
      {
        type: "image",
        source: { type: "url", value: "https://example.com/c" },
      },
    ]);
  });

  it("maps the AI SDK v6 data, URL and file-id items", async () => {
    expect(
      await contentFor([
        {
          type: "file-data",
          data: "cGRm",
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
        { type: "image-url", url: "https://example.com/b.jpg" },
        { type: "file-id", fileId: "file-abc" },
        { type: "image-file-id", fileId: { openai: "file-img" } },
      ]),
    ).toEqual([
      {
        type: "document",
        source: { type: "data", value: "cGRm", mimeType: "application/pdf" },
        metadata: { filename: "report.pdf" },
      },
      {
        type: "image",
        source: { type: "url", value: "https://example.com/b.jpg" },
      },
      { type: "document", source: { type: "file", value: "file-abc" } },
      {
        type: "image",
        source: { type: "file", value: "file-img", provider: "openai" },
      },
    ]);
  });

  it("falls back to the serialized result when no item maps onto a part", async () => {
    expect(await contentFor([{ type: "custom", providerOptions: {} }])).toBe(
      JSON.stringify({ raw: true }),
    );
  });
});

describe("tool messages given as content parts reach Mastra as model output", () => {
  const history = (content: Message["content"]): Message[] => [
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tc-1",
          type: "function",
          function: { name: "take_screenshot", arguments: "{}" },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "tc-1", content } as Message,
  ];

  // A failed assertion must not leave its console spy on the next test.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the text as the result and the parts as Mastra's model output", () => {
    const [, tool] = convertAGUIMessagesToMastra(
      history([
        { type: "text", text: "Here it is." },
        {
          type: "image",
          source: { type: "data", value: PNG, mimeType: "image/png" },
        },
      ]),
    );

    expect(tool.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "take_screenshot",
        result: "Here it is.",
        isError: false,
        providerOptions: {
          mastra: {
            modelOutput: {
              type: "content",
              value: [
                { type: "text", text: "Here it is." },
                { type: "media", data: PNG, mediaType: "image/png" },
              ],
            },
          },
        },
      },
    ]);
  });

  it("leaves a string result as it was", () => {
    const [, tool] = convertAGUIMessagesToMastra(history("done"));

    expect((tool.content as any[])[0]).toEqual({
      type: "tool-result",
      toolCallId: "tc-1",
      toolName: "take_screenshot",
      result: "done",
      isError: false,
    });
  });

  it("maps URL sources onto URL items and provider file sources onto file-id items", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [, tool] = convertAGUIMessagesToMastra(
      history([
        {
          type: "image",
          source: {
            type: "url",
            value: "https://example.com/a.png",
            mimeType: "image/png",
          },
        },
        {
          type: "image",
          source: { type: "url", value: "https://example.com/b" },
        },
        {
          type: "document",
          source: { type: "url", value: "https://example.com/c.pdf" },
        },
        { type: "document", source: { type: "file", value: "file-abc" } },
        {
          type: "image",
          source: { type: "file", value: "file-img", provider: "openai" },
        },
      ]),
    );

    expect(
      (tool.content as any[])[0].providerOptions.mastra.modelOutput,
    ).toEqual({
      type: "content",
      value: [
        { type: "image-url", url: "https://example.com/a.png" },
        { type: "image-url", url: "https://example.com/b" },
        { type: "file-url", url: "https://example.com/c.pdf" },
        { type: "file-id", fileId: "file-abc" },
        { type: "image-file-id", fileId: { openai: "file-img" } },
      ],
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("maps the emitted parts back onto items, with a URL in media as a URL item", async () => {
    const text = { type: "text", text: "Here:" };
    const bytes = { type: "media", data: PNG, mediaType: "image/png" };
    const handles = [
      { type: "file-url", url: "https://example.com/b.pdf" },
      { type: "file-id", fileId: "file-abc" },
      { type: "image-file-id", fileId: { openai: "file-img" } },
    ];
    const urlInMedia = {
      type: "media",
      data: "https://example.com/a.png",
      mediaType: "image/png",
    };
    const agent = makeLocalMastraAgent({
      streamChunks: [
        callChunk,
        resultChunk(
          { raw: true },
          { type: "content", value: [text, bytes, urlInMedia, ...handles] },
        ),
      ],
    });
    const parts = resultContent(await collectEvents(agent, makeInput()));

    const [, tool] = convertAGUIMessagesToMastra(history(parts));

    expect(
      (tool.content as any[])[0].providerOptions.mastra.modelOutput,
    ).toEqual({
      type: "content",
      value: [
        text,
        bytes,
        { type: "image-url", url: "https://example.com/a.png" },
        ...handles,
      ],
    });
  });

  it("drops a source of an unknown type, and answers with the empty string when none is left", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [, tool] = convertAGUIMessagesToMastra(
      history([
        { type: "image", source: { type: "blob", value: "x" } },
      ] as unknown as Message["content"]),
    );

    const part = (tool.content as any[])[0];
    expect(part.result).toBe("");
    expect(part.providerOptions.mastra.modelOutput).toEqual({
      type: "text",
      value: "",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("blob source");
    warn.mockRestore();
  });

  it("drops a media part that has no source, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [, tool] = convertAGUIMessagesToMastra(
      history([
        { type: "text", text: "Here it is." },
        { type: "image" },
      ] as unknown as Message["content"]),
    );

    expect(
      (tool.content as any[])[0].providerOptions.mastra.modelOutput,
    ).toEqual({
      type: "content",
      value: [{ type: "text", text: "Here it is." }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("no source");
    warn.mockRestore();
  });

  it("never yields an item without a media type, and warns for each data source it drops", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = contentPartsToModelOutput([
      { type: "image", source: { type: "data", value: PNG } },
      { type: "image", source: { type: "data", value: PNG, mimeType: "" } },
      {
        type: "document",
        source: { type: "data", value: 42, mimeType: "application/pdf" },
      },
      { type: "image", source: { type: "url", value: `data:;base64,${PNG}` } },
      { type: "image", source: { type: "url", value: CAT_URL } },
      { type: "document", source: { type: "url", value: DOC_URL } },
    ] as unknown as ContentPart[]);

    expect(output.type).toBe("content");
    const items = output.type === "content" ? output.value : [];
    for (const item of items) {
      if ("mediaType" in item) {
        expect(typeof item.mediaType).toBe("string");
        expect(item.mediaType).not.toBe("");
      }
    }
    expect(items).toEqual([
      { type: "media", data: PNG, mediaType: "text/plain" },
      { type: "image-url", url: CAT_URL },
      { type: "file-url", url: DOC_URL },
    ]);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain("mimeType");
    expect(messages[1]).toContain("mimeType");
    expect(messages[2]).toContain("string value");
  });
});

describe("user media parts without a source", () => {
  it.each(["image", "audio", "video", "document"])(
    "drops a %s part that has no source, with a warning",
    (type) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const [user] = convertAGUIMessagesToMastra([
        {
          id: "u1",
          role: "user",
          content: [{ type: "text", text: "Look" }, { type }],
        } as unknown as Message,
      ]);

      expect(user.content).toEqual([{ type: "text", text: "Look" }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("no source");
      warn.mockRestore();
    },
  );
});

// ---------------------------------------------------------------------------
// Real @mastra/core on a V2 mock model: a tool's toModelOutput comes out as
// parts, and tool results reach the mock's prompt in the shape asserted here.
// These pin the prompt shape only; what a provider is sent is covered by
// "tool result content: provider request body" below.
// ---------------------------------------------------------------------------

function scriptedModel(
  prompts: unknown[],
  firstTurn: Record<string, unknown>[],
) {
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: unknown }) => {
      prompts.push(prompt);
      const answered =
        Array.isArray(prompt) && prompt.some((m: any) => m.role === "tool");
      const chunks = answered
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Seen it." },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "stop",
            },
          ]
        : [
            ...firstTurn,
            {
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "tool-calls",
            },
          ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        request: { body: {} },
        response: undefined,
      };
    },
  });
}

describe("tool result content: real @mastra/core, mock prompt shape", () => {
  it("emits a server tool's toModelOutput content as parts", async () => {
    const prompts: unknown[] = [];
    const snapshot = createTool({
      id: "snapshot",
      description: "Take a snapshot",
      inputSchema: z.object({}),
      execute: async () => ({ png: PNG }),
      toModelOutput: (output) => ({
        type: "content",
        value: [
          { type: "text", text: "Snapshot:" },
          {
            type: "media",
            data: (output as { png: string }).png,
            mediaType: "image/png",
          },
        ],
      }),
    });
    const agent = new MastraAgent({
      agentId: "snap",
      agent: new Agent({
        id: "snap",
        name: "snap",
        instructions: "Take snapshots.",
        model: scriptedModel(prompts, [
          {
            type: "tool-call",
            toolCallId: "tc-snap",
            toolName: "snapshot",
            input: "{}",
          },
        ]) as any,
        tools: { snapshot },
      }),
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "Snap" }] }),
    );

    expect(resultContent(events)).toEqual([
      { type: "text", text: "Snapshot:" },
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
      },
    ]);
  });

  // The client sends its tool message back on every later turn, and Mastra
  // takes that result over the one it stored, so the parts are mapped back
  // onto items. A URL comes back as a URL item, not as the media Mastra
  // stored it as on the first turn.
  it.each([
    [
      "URL media",
      {
        type: "media",
        data: "https://example.com/cat.png",
        mediaType: "image/png",
      },
      { type: "image-url", url: "https://example.com/cat.png" },
    ],
    [
      "provider file id",
      { type: "image-file-id", fileId: { openai: "f1" } },
      { type: "image-file-id", fileId: { openai: "f1" } },
    ],
  ])(
    "replays a server tool's %s into the next turn's mock prompt",
    async (_label, item, replayed) => {
      const prompts: unknown[] = [];
      const snapshot = createTool({
        id: "snapshot",
        description: "Take a snapshot",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
        toModelOutput: () => ({
          type: "content",
          value: [{ type: "text", text: "Snapshot:" }, item],
        }),
      } as Parameters<typeof createTool>[0]);
      const agent = new MastraAgent({
        agentId: "snap",
        agent: new Agent({
          id: "snap",
          name: "snap",
          instructions: "Take snapshots.",
          model: scriptedModel(prompts, [
            {
              type: "tool-call",
              toolCallId: "tc-snap",
              toolName: "snapshot",
              input: "{}",
            },
          ]) as any,
          tools: { snapshot },
          memory: new MockMemory(),
        }),
        resourceId: "resource-1",
      });
      agent.threadId = "thread-snap";
      agent.setMessages([{ id: "u1", role: "user", content: "Snap" }]);
      await agent.runAgent({ runId: "run-1" });

      agent.setMessages([
        ...agent.messages,
        { id: "u2", role: "user", content: "Again" },
      ]);
      await agent.runAgent({ runId: "run-2" });

      const toolOutput = (prompt: unknown) =>
        (prompt as any[])
          .filter((m) => m.role === "tool")
          .flatMap((m) => m.content)
          .map((part) => part.output);
      const content = (last: unknown) => ({
        type: "content",
        value: [{ type: "text", text: "Snapshot:" }, last],
      });
      expect(toolOutput(prompts[1])).toEqual([content(item)]);
      expect(toolOutput(prompts.at(-1))).toEqual([content(replayed)]);
    },
  );

  it("puts a frontend tool's parts in the mock prompt as its content output", async () => {
    const prompts: unknown[] = [];
    const PICK: Tool = {
      name: "take_screenshot",
      description: "Screenshot the page",
      parameters: { type: "object", properties: {} },
    };
    const agent = new MastraAgent({
      agentId: "shots",
      agent: new Agent({
        id: "shots",
        name: "shots",
        instructions: "Look at the page.",
        model: scriptedModel(prompts, [
          {
            type: "tool-call",
            toolCallId: "tc-shot",
            toolName: "take_screenshot",
            input: "{}",
          },
        ]) as any,
      }),
      resourceId: "resource-1",
    });
    agent.threadId = "thread-shots";
    agent.setMessages([
      { id: "u1", role: "user", content: "What do you see?" },
    ]);
    await agent.runAgent({ runId: "run-1", tools: [PICK] });

    agent.setMessages([
      ...agent.messages,
      {
        id: "tool-1",
        role: "tool",
        toolCallId: "tc-shot",
        content: [
          { type: "text", text: "The page:" },
          {
            type: "image",
            source: { type: "data", value: PNG, mimeType: "image/png" },
          },
        ],
      } as Message,
    ]);
    await agent.runAgent({ runId: "run-2", tools: [PICK] });

    const toolMessage = (prompts[1] as any[]).find((m) => m.role === "tool");
    expect(toolMessage.content).toEqual([
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "tc-shot",
        output: {
          type: "content",
          value: [
            { type: "text", text: "The page:" },
            { type: "media", data: PNG, mediaType: "image/png" },
          ],
        },
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Real @mastra/core on Mastra's model router, with fetch stubbed: what the
// provider request body holds for a tool result, the one shape a real model
// is given.
// ---------------------------------------------------------------------------

const CAT_URL = "https://example.com/cat.png";
const DOC_URL = "https://example.com/doc.pdf";

const ROUTER_MODELS = [
  {
    model: "openai/gpt-4o-mini",
    imageBlock: (url: string) => ({ type: "input_image", image_url: url }),
    documentBlock: (url: string) => ({ type: "input_file", file_url: url }),
  },
  {
    model: "anthropic/claude-sonnet-4-5",
    imageBlock: (url: string) => ({
      type: "image",
      source: { type: "url", url },
    }),
    documentBlock: (url: string) => ({
      type: "document",
      source: { type: "url", url },
    }),
  },
];

describe("tool result content: provider request body", () => {
  let requests: ProviderRequest[];

  beforeEach(() => {
    requests = [];
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const PICK: Tool = {
    name: "take_screenshot",
    description: "Screenshot the page",
    parameters: { type: "object", properties: {} },
  };

  /** The first provider request of the turn that answers a frontend tool. */
  async function answerFrontendTool(model: string, content: ContentPart[]) {
    vi.stubGlobal("fetch", makeProviderFetch(requests, PICK.name));
    const agent = new MastraAgent({
      agentId: "shots",
      agent: new Agent({
        id: "shots",
        name: "shots",
        instructions: "Look at the page.",
        model,
      }),
      resourceId: "resource-1",
    });
    agent.threadId = "thread-shots";
    agent.setMessages([
      { id: "u1", role: "user", content: "What do you see?" },
    ]);
    await agent.runAgent({ runId: "run-1", tools: [PICK] });
    const call = agent.messages
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .find((c) => c.function.name === PICK.name);
    expect(call).toBeDefined();

    const sent = requests.length;
    const events: BaseEvent[] = [];
    agent.setMessages([
      ...agent.messages,
      { id: "tool-1", role: "tool", toolCallId: call!.id, content } as Message,
    ]);
    await agent.runAgent(
      { runId: "run-2", tools: [PICK] },
      { onEvent: ({ event }) => void events.push(event) },
    );
    expect(requests.length).toBeGreaterThan(sent);
    return { request: requests[sent], events };
  }

  /**
   * The last provider request of turn 1 (the step after the tool ran) and the
   * first of turn 2, for a server tool whose toModelOutput returns `item`.
   */
  async function replayServerTool(model: string, item: unknown) {
    vi.stubGlobal("fetch", makeProviderFetch(requests, "snapshot"));
    const snapshot = createTool({
      id: "snapshot",
      description: "Take a snapshot",
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
      toModelOutput: () => ({
        type: "content",
        value: [{ type: "text", text: "Snapshot:" }, item],
      }),
    } as Parameters<typeof createTool>[0]);
    const agent = new MastraAgent({
      agentId: "snap",
      agent: new Agent({
        id: "snap",
        name: "snap",
        instructions: "Take snapshots.",
        model,
        tools: { snapshot },
        memory: new MockMemory(),
      }),
      resourceId: "resource-1",
    });
    agent.threadId = "thread-snap";
    agent.setMessages([{ id: "u1", role: "user", content: "Snap" }]);
    await agent.runAgent({ runId: "run-1" });
    const firstTurn = requests.length;
    expect(firstTurn).toBe(2);

    agent.setMessages([
      ...agent.messages,
      { id: "u2", role: "user", content: "Again" },
    ]);
    await agent.runAgent({ runId: "run-2" });
    expect(requests.length).toBeGreaterThan(firstTurn);
    return { turn1: requests[firstTurn - 1], turn2: requests[firstTurn] };
  }

  const noBase64Url = (request: ProviderRequest) =>
    expect(JSON.stringify(request.body)).not.toMatch(/;base64,https?:/);

  describe.each(ROUTER_MODELS)(
    "$model",
    ({ model, imageBlock, documentBlock }) => {
      it("sends a frontend tool's image URL as a URL image", async () => {
        const { request } = await answerFrontendTool(model, [
          { type: "text", text: "The page:" },
          {
            type: "image",
            source: { type: "url", value: CAT_URL, mimeType: "image/png" },
          },
        ]);

        expect(toolResultsInBody(request)).toEqual([
          expect.arrayContaining([imageBlock(CAT_URL)]),
        ]);
        noBase64Url(request);
      });

      it("sends a frontend tool's document URL as a URL document", async () => {
        const { request } = await answerFrontendTool(model, [
          { type: "text", text: "The page:" },
          {
            type: "document",
            source: {
              type: "url",
              value: DOC_URL,
              mimeType: "application/pdf",
            },
          },
        ]);

        expect(toolResultsInBody(request)).toEqual([
          expect.arrayContaining([documentBlock(DOC_URL)]),
        ]);
        noBase64Url(request);
      });

      // Turn 1 is not the reference here: Mastra stores an image-url item as
      // media, which the router drops before the bridge is involved.
      it("sends a server tool's image URL on the next turn", async () => {
        const { turn2 } = await replayServerTool(model, {
          type: "image-url",
          url: CAT_URL,
        });

        expect(toolResultsInBody(turn2)).toEqual([
          expect.arrayContaining([imageBlock(CAT_URL)]),
        ]);
        noBase64Url(turn2);
      });

      it("sends a server tool's document URL on the next turn as on the first", async () => {
        const { turn1, turn2 } = await replayServerTool(model, {
          type: "file-url",
          url: DOC_URL,
          mediaType: "application/pdf",
        });

        expect(toolResultsInBody(turn1)).toEqual([
          expect.arrayContaining([documentBlock(DOC_URL)]),
        ]);
        expect(toolResultsInBody(turn2)).toEqual(toolResultsInBody(turn1));
      });

      it("drops a frontend tool's data image with no mimeType, with a warning, and finishes", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { request, events } = await answerFrontendTool(model, [
          { type: "text", text: "The page:" },
          { type: "image", source: { type: "data", value: PNG } },
        ] as unknown as ContentPart[]);

        const types = events.map((e) => e.type);
        expect(types).toContain(EventType.RUN_FINISHED);
        expect(types).not.toContain(EventType.RUN_ERROR);
        expect(
          warn.mock.calls.some(
            ([message]) =>
              String(message).includes("Dropping image tool result content") &&
              String(message).includes("mimeType"),
          ),
        ).toBe(true);
        for (const sent of requests) {
          expect(JSON.stringify(sent.body)).not.toContain("data:;base64");
        }
        expect(toolResultsInBody(request)).toEqual([
          [expect.objectContaining({ text: "The page:" })],
        ]);
      });
    },
  );
});
