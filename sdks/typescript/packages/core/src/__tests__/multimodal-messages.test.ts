import {
  UserMessageSchema,
  BinaryInputContentSchema,
} from "../types";

describe("Multimodal messages", () => {
  it("parses user message with content array", () => {
    const result = UserMessageSchema.parse({
      id: "user_multimodal",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Check this out" },
        { type: "binary" as const, mimeType: "image/png", url: "https://example.com/image.png" },
      ],
    });

    expect(Array.isArray(result.content)).toBe(true);
    if (Array.isArray(result.content)) {
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("Check this out");
      expect(result.content[1].type).toBe("binary");
      expect(result.content[1].mimeType).toBe("image/png");
      expect(result.content[1].url).toBe("https://example.com/image.png");
    }
  });

  it("rejects binary content without payload source", () => {
    const result = UserMessageSchema.safeParse({
      id: "user_invalid",
      role: "user" as const,
      content: [{ type: "binary" as const, mimeType: "image/png" }],
    });

    expect(result.success).toBe(false);
  });

  it("parses binary input with embedded data", () => {
    const binary = BinaryInputContentSchema.parse({
      type: "binary" as const,
      mimeType: "image/png",
      data: "base64",
    });

    expect(binary.data).toBe("base64");
  });

  it("requires binary payload source", () => {
    expect(() =>
      BinaryInputContentSchema.parse({ type: "binary" as const, mimeType: "image/png" }),
    ).toThrow(/id, url, or data/);
  });
});
