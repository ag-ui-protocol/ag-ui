import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { InputContent } from "@ag-ui/core";

import { convertAguiContentToStrands, flattenContentToText } from "../utils";

function b64(input: string): string {
  return Buffer.from(input).toString("base64");
}

describe("convertAguiContentToStrands", () => {
  it("maps TextInputContent to a TextBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "hello" },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("textBlock");
    expect((blocks[0] as unknown as { text: string }).text).toBe("hello");
  });

  it("maps ImageInputContent with a data source to an ImageBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "image",
        source: { type: "data", value: b64("PNG"), mimeType: "image/png" },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("imageBlock");
    expect((blocks[0] as unknown as { format: string }).format).toBe("png");
  });

  it("skips images with an unsupported MIME type", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "image",
        source: { type: "data", value: b64("xxx"), mimeType: "image/bmp" },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(0);
  });

  it("fetches url-sourced images", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const blocks = await convertAguiContentToStrands([
        {
          type: "image",
          source: {
            type: "url",
            value: "https://example.test/x.png",
            mimeType: "image/png",
          },
        },
      ] as InputContent[]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(blocks).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("maps DocumentInputContent to a DocumentBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "document",
        source: {
          type: "data",
          value: b64("pdfdata"),
          mimeType: "application/pdf",
        },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("documentBlock");
  });

  it("maps VideoInputContent to a VideoBlock", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "video",
        source: { type: "data", value: b64("movie"), mimeType: "video/mp4" },
      },
    ] as InputContent[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("videoBlock");
  });

  it("skips audio content silently", async () => {
    const blocks = await convertAguiContentToStrands([
      { type: "text", text: "before" },
      {
        type: "audio",
        source: { type: "data", value: b64("sound"), mimeType: "audio/wav" },
      },
      { type: "text", text: "after" },
    ] as InputContent[]);
    // Just the two text blocks remain
    expect(blocks).toHaveLength(2);
  });

  it("drops items with bad base64 data rather than throwing", async () => {
    const blocks = await convertAguiContentToStrands([
      {
        type: "image",
        source: {
          type: "data",
          value: "!!!not base64!!!",
          mimeType: "image/png",
        },
      },
    ] as InputContent[]);
    expect(blocks).toEqual([]);
  });
});

describe("flattenContentToText", () => {
  it("returns a string input as-is", () => {
    expect(flattenContentToText("hi")).toBe("hi");
  });
  it("returns empty string for null / undefined", () => {
    expect(flattenContentToText(null)).toBe("");
    expect(flattenContentToText(undefined)).toBe("");
  });
  it("joins TextInputContent segments with a space", () => {
    expect(
      flattenContentToText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello world");
  });
  it("ignores non-text blocks", () => {
    expect(
      flattenContentToText([
        { type: "text", text: "a" },
        {
          type: "image",
          source: { type: "data", value: "x", mimeType: "image/png" },
        },
        { type: "text", text: "b" },
      ]),
    ).toBe("a b");
  });
});
