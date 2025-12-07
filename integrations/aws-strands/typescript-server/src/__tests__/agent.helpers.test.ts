import { convertMessageContent, applyBuilderTextToBlocks } from "../agent-content";
import {
  extractTextChunk,
  getToolResultText,
  isAguiEvent,
  isAsyncGenerator,
  isToolResultItem,
  isUserMessage,
  parseJsonLenient,
  toStreamEvent,
} from "../agent-streaming";
import { extractTools, getToolName } from "../agent-tools";

describe("agent-content helpers", () => {
  it("converts various message shapes and falls back safely", () => {
    const circular: any = {};
    circular.self = circular;

    const empty = convertMessageContent();
    expect(empty).toEqual({
      blocks: [],
      textSummary: "",
      textBlockIndexes: [],
      hasBinaryContent: false,
    });

    const fromCircular = convertMessageContent(circular);
    expect(fromCircular.textSummary).toBe("[object Object]");

    const dataImage = Buffer.from("gif-bytes").toString("base64");
    const dataDoc = Buffer.from("doc-bytes").toString("base64");

    const circularItem: any = {};
    circularItem.self = circularItem;

    const mixed = convertMessageContent([
      { type: "text", text: "hello" },
      { type: "binary", mimeType: "image/png", url: "https://files/picture.png" },
      { type: "binary", mimeType: "image/png", url: "not a url" },
      { type: "binary", mimeType: "image/custom", filename: "photo.gif", data: dataImage },
      { type: "binary", mimeType: "application/pdf", data: dataDoc },
      {
        type: "binary",
        mimeType: "application/octet-stream",
        filename: "notes.md",
        data: dataDoc,
      },
      { type: "binary", mimeType: "application/json" },
      { type: "binary", mimeType: "image/unknown" },
      { type: "binary", mimeType: "application/unknown", data: "bad,data" },
      { type: "binary", mimeType: "application/x-unknown" },
      null,
      42,
      true,
      { text: "loose" },
      { custom: "object" },
      circularItem,
    ]);

    expect(mixed.textSummary).toContain("hello");
    expect(mixed.blocks.some((b) => "image" in b)).toBe(true);
    expect(mixed.blocks.some((b) => "document" in b)).toBe(true);
    expect(mixed.textBlockIndexes.length).toBeGreaterThan(0);
    expect(mixed.hasBinaryContent).toBe(true);
  });

  it("falls back to text when no document format can be guessed", () => {
    const result = convertMessageContent([
      { type: "binary", mimeType: "application/x-unknown-format" },
    ]);
    expect(result.blocks[0]).toEqual({
      text: expect.stringContaining("Attachment application/x-unknown-format"),
    });
  });

  it("handles binary mime strings without a subtype", () => {
    const result = convertMessageContent([{ type: "binary", mimeType: "unknown" }]);
    expect(result.blocks[0]).toEqual({
      text: expect.stringContaining("Attachment unknown"),
    });
  });

  it("replaces text blocks using applyBuilderTextToBlocks", () => {
    expect(applyBuilderTextToBlocks([], [], "new")).toEqual([{ text: "new" }]);

    const replaced = applyBuilderTextToBlocks(
      [{ text: "old" }, { image: { format: "png", source: { url: "u" } } }],
      [0],
      "updated"
    );
    expect(replaced[0]).toEqual({ text: "updated" });
    expect("image" in replaced[1]).toBe(true);

    const prepended = applyBuilderTextToBlocks([{ text: "keep" }], [], "start");
    expect(prepended[0]).toEqual({ text: "start" });
    expect(prepended[1]).toEqual({ text: "keep" });
  });

  it("handles base64 decoding failures gracefully", () => {
    const bufferSpy = jest.spyOn(Buffer, "from").mockImplementation(() => {
      throw new Error("decode failure");
    });

    const result = convertMessageContent([
      { type: "binary", mimeType: "image/png", data: "bad" },
    ]);
    expect(result.blocks[0]).toEqual({
      text: expect.stringContaining("Attachment image/png"),
    });

    bufferSpy.mockRestore();
  });

  it("covers misc fallbacks in content helpers", () => {
    expect(convertMessageContent("")).toEqual({
      blocks: [],
      textSummary: "",
      textBlockIndexes: [],
      hasBinaryContent: false,
    });

    expect(applyBuilderTextToBlocks([], [], "")).toEqual([]);

    const commaBase64 = "prefix," + Buffer.from("ok").toString("base64");
    const withComma = convertMessageContent([
      { type: "binary", mimeType: "application/json", data: commaBase64 },
      { type: "binary", mimeType: "text/plain" },
    ]);
    expect(withComma.blocks[0]).toMatchObject({
      document: expect.any(Object),
    });
    expect(withComma.blocks.at(-1)).toEqual({
      text: "[Attachment text/plain: text/plain]",
    });
  });
});

describe("agent-streaming helpers", () => {
  it("normalizes stream events and text chunks", () => {
    expect(toStreamEvent(5)).toEqual({});
    expect(isUserMessage({ role: "user" })).toBe(true);
    expect(isUserMessage({ role: "assistant" })).toBe(false);
    expect(isToolResultItem({ toolResult: { toolUseId: "1" } })).toBe(true);
    expect(isToolResultItem({})).toBe(false);
    expect(isToolResultItem(null)).toBe(false);
    expect(getToolResultText([{ text: "ok" }])).toBe("ok");
    expect(getToolResultText([{ not: "ok" }])).toBeNull();
    expect(getToolResultText("nope")).toBeNull();

    expect(parseJsonLenient('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLenient("{'a':1}")).toEqual({ a: 1 });
    expect(parseJsonLenient("raw")).toBe("raw");

    expect(isAguiEvent({ type: "X" })).toBe(true);
    expect(isAguiEvent({})).toBe(false);

    expect(extractTextChunk({ data: 2 } as any)).toBe("2");
    expect(extractTextChunk({ delta: ["a", 1, true] } as any)).toBe("a1true");
    expect(
      extractTextChunk({
        delta: { type: "textDelta", delta: { delta: "nested" } },
      } as any)
    ).toBe("nested");
    expect(
      extractTextChunk({
        delta: { type: "other", text: "skip" },
      } as any)
    ).toBeNull();
    expect(extractTextChunk({ delta: [null, undefined] } as any)).toBeNull();
    expect(
      extractTextChunk({
        type: "chunk",
        delta: { type: "textDelta", text: "typed" },
      } as any)
    ).toBe("typed");
    expect(
      extractTextChunk({
        type: "chunk",
        delta: { type: "custom", other: true },
      } as any)
    ).toBeNull();
    expect(extractTextChunk({ data: {} } as any)).toBeNull();
    expect(
      extractTextChunk({
        delta: { type: "textDelta", content: "content text" },
      } as any)
    ).toBe("content text");
    expect(
      extractTextChunk({
        delta: { type: "output_text", value: "val" },
      } as any)
    ).toBe("val");
    expect(
      extractTextChunk({
        delta: { type: "output_text", output_text: "out" },
      } as any)
    ).toBe("out");
    expect(
      extractTextChunk({
        delta: { type: "textDelta", text: { nested: true } },
      } as any)
    ).toBeNull();
    expect(
      extractTextChunk({
        delta: () => {},
      } as any)
    ).toBeNull();
    const delayed: any = { type: "chunk" };
    let callCount = 0;
    Object.defineProperty(delayed, "delta", {
      get() {
        callCount += 1;
        return callCount === 1 ? undefined : "late";
      },
    });
    expect(extractTextChunk(delayed)).toBe("late");
    expect(extractTextChunk({ type: "chunk", delta: undefined } as any)).toBeNull();

    async function* gen() {
      yield 1;
    }
    expect(isAsyncGenerator(gen())).toBe(true);
    expect(isAsyncGenerator([] as any)).toBe(false);
  });
});

describe("agent-tools helpers", () => {
  it("extracts tools from registries and arrays", () => {
    expect(extractTools({ toolRegistry: { registry: new Map([["a", 1]]) } })).toEqual([1]);

    const registryLike = { values: () => ["x", "y"] };
    expect(extractTools({ toolRegistry: { registry: registryLike as any } })).toEqual([
      "x",
      "y",
    ]);

    expect(extractTools({ tools: ["one", "two"] })).toEqual(["one", "two"]);
    expect(extractTools({})).toEqual([]);
  });

  it("gets tool names from different shapes", () => {
    expect(getToolName("plain")).toBe("plain");
    expect(getToolName({ name: "n" })).toBe("n");
    expect(getToolName({ tool_name: "t" })).toBe("t");
    expect(getToolName({})).toBeNull();
  });
});
