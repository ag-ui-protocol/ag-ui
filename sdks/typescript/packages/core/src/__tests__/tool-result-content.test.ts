import { describe, expect, it } from "vitest";
import {
  ContentPartSchema,
  TextPartSchema,
  ToolCallResultEventSchema,
  ToolMessageSchema,
  // The pre-1.0 names, kept as aliases of the same validators.
  InputContentSchema,
  TextInputContentSchema,
  ImageInputContentSchema,
  AudioInputContentSchema,
  VideoInputContentSchema,
  DocumentInputContentSchema,
  InputContentSourceSchema,
  InputContentDataSourceSchema,
  InputContentUrlSourceSchema,
  ImagePartSchema,
  AudioPartSchema,
  VideoPartSchema,
  DocumentPartSchema,
  PartSourceSchema,
  DataSourceSchema,
  UrlSourceSchema,
} from "../schemas";
import { contentHasMedia, contentToText, EventType } from "../index";
import type { ContentPart, InputContent, TextInputContent, ToolMessage } from "../index";

const parts: ContentPart[] = [
  {
    type: "text",
    id: "p1",
    text: "Proration rules: when a plan changes mid-cycle...",
    metadata: { source: "https://docs.internal/billing/proration", title: "Proration rules" },
  },
  {
    type: "document",
    source: { type: "data", value: "JVBERi0x", mimeType: "application/pdf" },
  },
];

describe("tool result content", () => {
  it("accepts a string on the tool message, as before", () => {
    const message = ToolMessageSchema.parse({
      id: "m1",
      role: "tool",
      toolCallId: "c1",
      content: "3 results found.",
    });
    expect(message.content).toBe("3 results found.");
  });

  it("accepts a list of parts on the tool message", () => {
    const message = ToolMessageSchema.parse({
      id: "m1",
      role: "tool",
      toolCallId: "c1",
      content: parts,
    });
    expect(message.content).toEqual(parts);
  });

  it("accepts an empty list of parts", () => {
    const message = ToolMessageSchema.parse({
      id: "m1",
      role: "tool",
      toolCallId: "c1",
      content: [],
    });
    expect(message.content).toEqual([]);
  });

  it("accepts the same parts on TOOL_CALL_RESULT", () => {
    const event = ToolCallResultEventSchema.parse({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m2",
      toolCallId: "c1",
      content: parts,
    });
    expect(event.content).toEqual(parts);
  });

  it("rejects a part whose type the protocol does not model", () => {
    expect(() =>
      ToolMessageSchema.parse({
        id: "m1",
        role: "tool",
        toolCallId: "c1",
        content: [{ type: "search_result", source: "https://example.com", title: "x" }],
      }),
    ).toThrow();
  });

  it("rejects a bare object: structured data is serialised into text", () => {
    expect(() =>
      ToolMessageSchema.parse({
        id: "m1",
        role: "tool",
        toolCallId: "c1",
        content: { temperature: 22.5 },
      }),
    ).toThrow();
  });
});

describe("text parts", () => {
  it("carry an optional id and metadata, like the media parts", () => {
    const part = TextPartSchema.parse({
      type: "text",
      id: "p1",
      text: "hi",
      metadata: { title: "t" },
    });
    expect(part).toEqual({ type: "text", id: "p1", text: "hi", metadata: { title: "t" } });
    expect(TextPartSchema.parse({ type: "text", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
    });
  });

  it("reject a null metadata, as the media parts do", () => {
    expect(() => TextPartSchema.parse({ type: "text", text: "hi", metadata: null })).toThrow();
  });
});

describe("the pre-1.0 part names", () => {
  it("are the same validators under their old names", () => {
    expect(InputContentSchema).toBe(ContentPartSchema);
    expect(TextInputContentSchema).toBe(TextPartSchema);
    expect(ImageInputContentSchema).toBe(ImagePartSchema);
    expect(AudioInputContentSchema).toBe(AudioPartSchema);
    expect(VideoInputContentSchema).toBe(VideoPartSchema);
    expect(DocumentInputContentSchema).toBe(DocumentPartSchema);
    expect(InputContentSourceSchema).toBe(PartSourceSchema);
    expect(InputContentDataSourceSchema).toBe(DataSourceSchema);
    expect(InputContentUrlSourceSchema).toBe(UrlSourceSchema);
  });

  it("are the same types under their old names", () => {
    // Assignability in both directions is the whole claim; the runtime
    // assertion only keeps the test from being empty.
    const part: TextInputContent = { type: "text", text: "hi" };
    const modern: ContentPart = part;
    const legacy: InputContent = modern;
    const message: ToolMessage = { id: "m", role: "tool", toolCallId: "c", content: [legacy] };
    expect(message.content).toHaveLength(1);
  });
});

describe("contentToText", () => {
  it("returns a string unchanged", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("concatenates the text parts in order and drops the rest, with no placeholder", () => {
    expect(
      contentToText([
        { type: "text", text: "a" },
        { type: "image", source: { type: "url", value: "https://example.com/x.png" } },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("flattens all-media and absent content to the empty string", () => {
    expect(
      contentToText([
        { type: "image", source: { type: "url", value: "https://example.com/x.png" } },
      ]),
    ).toBe("");
    expect(contentToText([])).toBe("");
    expect(contentToText(undefined)).toBe("");
  });

  it("says whether flattening would lose anything", () => {
    expect(contentHasMedia("hello")).toBe(false);
    expect(contentHasMedia([{ type: "text", text: "a" }])).toBe(false);
    expect(
      contentHasMedia([
        { type: "audio", source: { type: "url", value: "https://example.com/a.wav" } },
      ]),
    ).toBe(true);
  });
});
