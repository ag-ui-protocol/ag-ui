import { type Message } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";

import { convertMessage } from "../message-converter";

describe("AG-UI to ADK message conversion", () => {
  it("preserves text and multimodal user parts", () => {
    const message: Message = {
      id: "user-multimodal",
      role: "user",
      content: [
        { type: "text", text: "Describe these" },
        {
          type: "image",
          source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" },
        },
        {
          type: "audio",
          source: {
            type: "url",
            value: "gs://bucket/audio.wav",
            mimeType: "audio/wav",
          },
        },
        {
          type: "document",
          source: {
            type: "url",
            value: "gs://bucket/file.pdf",
            mimeType: "application/pdf",
          },
        },
      ],
    };

    expect(convertMessage(message, [message], "model")).toEqual({
      author: "user",
      content: {
        role: "user",
        parts: [
          { text: "Describe these" },
          { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
          {
            fileData: {
              fileUri: "gs://bucket/audio.wav",
              mimeType: "audio/wav",
            },
          },
          {
            fileData: {
              fileUri: "gs://bucket/file.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    });
  });

  it("rejects malformed tool arguments instead of changing their shape", () => {
    const message: Message = {
      id: "assistant-1",
      role: "assistant",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{not-json" },
        },
      ],
    };
    expect(() => convertMessage(message, [message], "model")).toThrowError(
      expect.objectContaining({ code: "INVALID_TOOL_ARGUMENTS" }),
    );
  });

  it("carries a tool result's media in the function response parts", () => {
    const assistant: Message = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "screenshot", arguments: "{}" },
        },
      ],
    };
    const result: Message = {
      id: "tool-1",
      role: "tool",
      toolCallId: "call-1",
      content: [
        { type: "text", text: '{"ok":true}' },
        {
          type: "image",
          source: { type: "data", value: "aW1n", mimeType: "image/png" },
        },
      ],
    };

    // Text -> `response`, media -> `parts`.
    expect(convertMessage(result, [assistant, result], "model")).toEqual({
      author: "user",
      content: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call-1",
              name: "screenshot",
              response: { ok: true },
              parts: [{ inlineData: { data: "aW1n", mimeType: "image/png" } }],
            },
          },
        ],
      },
    });
  });

  it("keeps a failed tool result's error alongside its content", () => {
    const assistant: Message = {
      id: "assistant-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    };
    // TOOL_CALL_RESULT has no `error` field; ToolMessage does.
    const result: Message = {
      id: "tool-1",
      role: "tool",
      toolCallId: "call-1",
      content: '{"partial":42}',
      error: "upstream timed out",
    };

    expect(convertMessage(result, [assistant, result], "model")).toMatchObject({
      content: {
        parts: [
          {
            functionResponse: {
              response: { partial: 42, error: "upstream timed out" },
            },
          },
        ],
      },
    });
  });

  it("skips another provider's file handle instead of failing the run", () => {
    const warn = vi.fn();
    const message: Message = {
      id: "user-media",
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
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
    };
    expect(
      convertMessage(message, [message], "model", undefined, {
        warn,
        error: vi.fn(),
      }),
    ).toEqual({
      author: "user",
      content: { role: "user", parts: [{ text: "Describe this" }] },
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("hands a Google file handle to ADK untouched", () => {
    const message: Message = {
      id: "user-media",
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "file",
            value: "gs://bucket/photo.png",
            provider: "google",
            mimeType: "image/png",
          },
        },
      ],
    };
    expect(convertMessage(message, [message], "model")).toEqual({
      author: "user",
      content: {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: "gs://bucket/photo.png",
              mimeType: "image/png",
            },
          },
        ],
      },
    });
  });

  it("restores a reasoning message with its thought signature into ADK history", () => {
    const message: Message = {
      id: "reasoning-1",
      role: "reasoning",
      content: "Consider the options",
      encryptedValue: "sig-r",
    };
    expect(convertMessage(message, [message], "model")).toEqual({
      author: "model",
      content: {
        role: "model",
        parts: [
          {
            text: "Consider the options",
            thought: true,
            thoughtSignature: "sig-r",
          },
        ],
      },
    });
  });

  it("keeps an attachment's filename as the ADK display name", () => {
    const message: Message = {
      id: "user-named-media",
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "data", value: "cGRm", mimeType: "application/pdf" },
          metadata: { filename: "report.pdf" },
        },
        {
          type: "image",
          source: { type: "url", value: "gs://bucket/cat.png" },
          metadata: { filename: "cat.png" },
        },
        {
          type: "image",
          source: { type: "data", value: "aW1n", mimeType: "image/png" },
          metadata: { filename: "" },
        },
      ],
    };
    expect(convertMessage(message, [message], "model")?.content.parts).toEqual([
      {
        inlineData: {
          data: "cGRm",
          mimeType: "application/pdf",
          displayName: "report.pdf",
        },
      },
      { fileData: { fileUri: "gs://bucket/cat.png", displayName: "cat.png" } },
      { inlineData: { data: "aW1n", mimeType: "image/png" } },
    ]);
  });
});
