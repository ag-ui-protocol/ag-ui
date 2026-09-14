import {
  UserMessageSchema,
  MessageSchema,
  FileSourceSchema,
  ImageInputContentSchema,
  AudioInputContentSchema,
  VideoInputContentSchema,
  DocumentInputContentSchema,
  ImageInputPartSchema,
  InputContentDataSourceSchema,
  InputContentUrlSourceSchema,
} from "../schemas";

const MODALITIES = ["image", "audio", "video", "document"] as const;

const MIME_BY_MODALITY: Record<(typeof MODALITIES)[number], string> = {
  image: "image/png",
  audio: "audio/wav",
  video: "video/mp4",
  document: "application/pdf",
};

const SCHEMA_BY_MODALITY = {
  image: ImageInputContentSchema,
  audio: AudioInputContentSchema,
  video: VideoInputContentSchema,
  document: DocumentInputContentSchema,
} as const;

describe("Multimodal messages", () => {
  it("parses user message with content array", () => {
    const result = UserMessageSchema.parse({
      id: "user_multimodal",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Check this out" },
        {
          type: "image" as const,
          source: {
            type: "url" as const,
            value: "https://example.com/image.png",
            mimeType: "image/png",
          },
        },
      ],
    });

    expect(Array.isArray(result.content)).toBe(true);
    if (Array.isArray(result.content)) {
      expect(result.content[0].type).toBe("text");
      if (result.content[0].type === "text") {
        expect(result.content[0].text).toBe("Check this out");
      }
      expect(result.content[1].type).toBe("image");
      if (result.content[1].type === "image") {
        expect(result.content[1].source.type).toBe("url");
        expect(result.content[1].source.value).toBe("https://example.com/image.png");
      }
    }
  });

  it("parses image part with inline data source", () => {
    const result = ImageInputPartSchema.parse({
      type: "image",
      source: {
        type: "data",
        value: "base64-value",
        mimeType: "image/png",
      },
      metadata: {
        detail: "high",
      },
    });

    expect(result.source.type).toBe("data");
    if (result.source.type === "data") {
      expect(result.source.mimeType).toBe("image/png");
    }
  });

  it("parses url source", () => {
    const result = InputContentUrlSourceSchema.parse({
      type: "url",
      value: "https://example.com/file.pdf",
    });

    expect(result.value).toBe("https://example.com/file.pdf");
  });

  it("parses data source", () => {
    const result = InputContentDataSourceSchema.parse({
      type: "data",
      value: "Zm9v",
      mimeType: "application/pdf",
    });

    expect(result.mimeType).toBe("application/pdf");
  });

  it("parses file source", () => {
    const result = FileSourceSchema.parse({
      type: "file",
      value: "file-abc123",
      provider: "openai",
      mimeType: "application/pdf",
    });

    expect(result).toEqual({
      type: "file",
      value: "file-abc123",
      provider: "openai",
      mimeType: "application/pdf",
    });
  });

  it("parses a minimal file source, leaving provider and mimeType absent", () => {
    const result = FileSourceSchema.parse({
      type: "file",
      value: "files/abc123",
    });

    expect(result.value).toBe("files/abc123");
    expect(result.provider).toBeUndefined();
    expect(result.mimeType).toBeUndefined();
    expect("provider" in result).toBe(false);
    expect("mimeType" in result).toBe(false);
  });

  it("rejects a file source without a value: the handle is the whole point", () => {
    expect(FileSourceSchema.safeParse({ type: "file", provider: "openai" }).success).toBe(false);
  });

  describe.each(MODALITIES)("%s modality combinations", (modality) => {
    it.each([true, false])("parses url source (metadata: %s)", (withMetadata) => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "url",
          value: `https://example.com/${modality}`,
          mimeType: MIME_BY_MODALITY[modality],
        },
        ...(withMetadata ? { metadata: { providerHint: "high" } } : {}),
      });

      expect(result.type).toBe(modality);
      expect(result.source.type).toBe("url");
      expect(result.source.value).toBe(`https://example.com/${modality}`);
      if (withMetadata) {
        expect(result.metadata).toEqual({ providerHint: "high" });
      } else {
        expect(result.metadata).toBeUndefined();
      }
    });

    it.each([true, false])("parses data source (metadata: %s)", (withMetadata) => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "data",
          value: "Zm9v",
          mimeType: MIME_BY_MODALITY[modality],
        },
        ...(withMetadata ? { metadata: { providerHint: "high" } } : {}),
      });

      expect(result.type).toBe(modality);
      expect(result.source.type).toBe("data");
      if (result.source.type === "data") {
        expect(result.source.mimeType).toBe(MIME_BY_MODALITY[modality]);
      }
      if (withMetadata) {
        expect(result.metadata).toEqual({ providerHint: "high" });
      } else {
        expect(result.metadata).toBeUndefined();
      }
    });

    it.each([true, false])("parses file source (metadata: %s)", (withMetadata) => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "file",
          value: `file-${modality}-abc123`,
          provider: "openai",
          mimeType: MIME_BY_MODALITY[modality],
        },
        ...(withMetadata ? { metadata: { providerHint: "high" } } : {}),
      });

      expect(result.type).toBe(modality);
      expect(result.source.type).toBe("file");
      if (result.source.type === "file") {
        expect(result.source.value).toBe(`file-${modality}-abc123`);
        expect(result.source.provider).toBe("openai");
        expect(result.source.mimeType).toBe(MIME_BY_MODALITY[modality]);
      }
      if (withMetadata) {
        expect(result.metadata).toEqual({ providerHint: "high" });
      } else {
        expect(result.metadata).toBeUndefined();
      }
    });

    it("accepts file source without provider or mimeType, and leaves them absent", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "file",
          value: `file-${modality}-bare`,
        },
      });

      expect(result.source.type).toBe("file");
      if (result.source.type === "file") {
        expect(result.source.provider).toBeUndefined();
        expect(result.source.mimeType).toBeUndefined();
      }
    });

    it("rejects file source without value", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
        source: {
          type: "file",
          provider: "openai",
          mimeType: MIME_BY_MODALITY[modality],
        },
      });

      expect(result.success).toBe(false);
    });

    it("accepts url source without mimeType", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.parse({
        type: modality,
        source: {
          type: "url",
          value: `https://example.com/${modality}/raw`,
        },
      });

      expect(result.source.type).toBe("url");
      if (result.source.type === "url") {
        expect(result.source.mimeType).toBeUndefined();
      }
    });

    it("rejects data source without mimeType", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
        source: {
          type: "data",
          value: "Zm9v",
        },
      });

      expect(result.success).toBe(false);
    });

    it("rejects missing source", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
      });

      expect(result.success).toBe(false);
    });

    it("rejects invalid source discriminator", () => {
      const schema = SCHEMA_BY_MODALITY[modality];
      const result = schema.safeParse({
        type: modality,
        source: {
          // Not one of data / url / file: the union has exactly three arms.
          type: "blob",
          value: "abc",
        },
      });

      expect(result.success).toBe(false);
    });
  });

  it("parses a user message containing all modalities", () => {
    const result = UserMessageSchema.parse({
      id: "user_all_modalities",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Process all inputs" },
        {
          type: "image" as const,
          source: { type: "url" as const, value: "https://example.com/image.png" },
        },
        {
          type: "audio" as const,
          source: { type: "data" as const, value: "Zm9v", mimeType: "audio/wav" },
        },
        {
          type: "video" as const,
          source: { type: "url" as const, value: "https://example.com/video.mp4" },
        },
        {
          type: "document" as const,
          source: { type: "data" as const, value: "YmFy", mimeType: "application/pdf" },
        },
      ],
    });

    expect(Array.isArray(result.content)).toBe(true);
    if (Array.isArray(result.content)) {
      expect(result.content.map((item) => item.type)).toEqual([
        "text",
        "image",
        "audio",
        "video",
        "document",
      ]);
    }
  });

  it("parses a user message whose document part names a provider-held file", () => {
    const payload = {
      id: "user_file_source",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Here is the invoice." },
        {
          type: "document" as const,
          id: "part_1",
          source: {
            type: "file" as const,
            value: "file-abc123",
            provider: "openai",
            mimeType: "application/pdf",
          },
          metadata: { title: "INV-2291" },
        },
      ],
    };

    for (const schema of [UserMessageSchema, MessageSchema]) {
      const result = schema.parse(payload);

      expect(Array.isArray(result.content)).toBe(true);
      if (Array.isArray(result.content)) {
        const part = result.content[1];
        expect(part.type).toBe("document");
        if (part.type === "document") {
          // Every field survives: the handle is opaque and must not be rewritten.
          expect(part.source).toEqual({
            type: "file",
            value: "file-abc123",
            provider: "openai",
            mimeType: "application/pdf",
          });
          expect(part.id).toBe("part_1");
          expect(part.metadata).toEqual({ title: "INV-2291" });
        }
      }
    }
  });

  it("parses a user message with a minimal file source, leaving the optionals absent", () => {
    const result = UserMessageSchema.parse({
      id: "user_file_source_minimal",
      role: "user" as const,
      content: [
        {
          type: "image" as const,
          source: { type: "file" as const, value: "file-minimal" },
        },
      ],
    });

    expect(Array.isArray(result.content)).toBe(true);
    if (Array.isArray(result.content)) {
      const part = result.content[0];
      if (part.type === "image" && part.source.type === "file") {
        expect(part.source.value).toBe("file-minimal");
        expect(part.source.provider).toBeUndefined();
        expect(part.source.mimeType).toBeUndefined();
        expect(part.source).toEqual({ type: "file", value: "file-minimal" });
      }
    }
  });

  it("rejects a user message whose file source carries no value", () => {
    const result = UserMessageSchema.safeParse({
      id: "user_file_source_invalid",
      role: "user" as const,
      content: [
        {
          type: "document" as const,
          source: { type: "file" as const, provider: "anthropic" },
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
