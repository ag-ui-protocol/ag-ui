import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Message, Tool } from "@ag-ui/client";
import { ToolCallResultEventSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { z } from "zod";
import {
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";
import { MastraAgent } from "../mastra";
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

  it("drops parts it cannot forward, and answers with the empty string when none is left", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [, tool] = convertAGUIMessagesToMastra(
      history([
        {
          type: "image",
          source: { type: "url", value: "https://example.com/c.png" },
        },
        {
          type: "document",
          source: { type: "file", value: "file-1", provider: "openai" },
        },
      ]),
    );

    const part = (tool.content as any[])[0];
    expect(part.result).toBe("");
    expect(part.providerOptions.mastra.modelOutput).toEqual({
      type: "text",
      value: "",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("url source");
    expect(warn.mock.calls[1][0]).toContain("file source");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Real @mastra/core: a tool's toModelOutput comes out as parts, and a frontend
// tool's parts go into the next model prompt as its content output.
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

describe("tool result content: real @mastra/core", () => {
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

  it("sends a frontend tool's parts to the model as its content output", async () => {
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
