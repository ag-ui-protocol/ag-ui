import {
  UserMessageSchema,
  assertUserMessageHasBody,
  userMessageHasBody,
  createTextInputContent,
  createBinaryInputContent,
  normalizeInputContent,
  encodeBinaryData,
  decodeBinaryData,
} from "../types";
import { MessagesSnapshotEventSchema, EventType } from "../events";

describe("UserMessageSchema multimodal content", () => {
  it("accepts plain string content", () => {
    const message = UserMessageSchema.parse({
      id: "msg-1",
      role: "user",
      content: "Hello",
    });

    expect(message.content).toBe("Hello");
    expect(userMessageHasBody(message)).toBe(true);
  });

  it("accepts text and binary content array", () => {
    const message = UserMessageSchema.parse({
      id: "msg-2",
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        {
          type: "binary",
          mimeType: "image/png",
          data: "base64-data",
          filename: "screenshot.png",
        },
      ],
    });

    expect(Array.isArray(message.content)).toBe(true);
    expect((message.content ?? [])[0]).toMatchObject({ type: "text", text: "Look at this" });
    expect(userMessageHasBody(message)).toBe(true);
  });

  it("accepts binary-only content", () => {
    const message = UserMessageSchema.parse({
      id: "msg-3",
      role: "user",
      content: [
        {
          type: "binary",
          mimeType: "application/pdf",
          url: "https://example.com/report.pdf",
        },
      ],
    });

    expect(Array.isArray(message.content)).toBe(true);
    expect(userMessageHasBody(message)).toBe(true);
  });

  it("rejects missing content", () => {
    expect(() =>
      UserMessageSchema.parse({
        id: "msg-4",
        role: "user",
      }),
    ).toThrow(/User messages must include content/);
  });

  it("rejects empty content array", () => {
    expect(() =>
      UserMessageSchema.parse({
        id: "msg-5",
        role: "user",
        content: [],
      }),
    ).toThrow(/User messages must include non-empty text or binary content/);
  });

  it("rejects whitespace-only text", () => {
    expect(() =>
      UserMessageSchema.parse({
        id: "msg-6",
        role: "user",
        content: "   ",
      }),
    ).toThrow(/User messages must include non-empty text or binary content/);
  });

  it("throws via assert helper when body missing", () => {
    expect(() =>
      assertUserMessageHasBody({
        id: "msg-7",
        role: "user",
        content: [],
      } as any),
    ).toThrow(/User messages must include non-empty text or binary content/);
  });

  it("parses message snapshots containing multimodal content", () => {
    const parsed = MessagesSnapshotEventSchema.parse({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "msg-8",
          role: "user",
          content: [
            { type: "text", text: "Check this audio file" },
            {
              type: "binary",
              mimeType: "audio/wav",
              id: "upload-123",
            },
          ],
        },
      ],
    });

    const message = parsed.messages[0];
    expect(Array.isArray(message.content)).toBe(true);
    const binary = (message.content as any[])[1];
    expect(binary.mimeType).toBe("audio/wav");
    expect(binary.id).toBe("upload-123");
  });

  it("creates content helpers correctly", () => {
    const textContent = createTextInputContent("Helper text");
    expect(textContent).toEqual({ type: "text", text: "Helper text" });

    const encoded = encodeBinaryData(new TextEncoder().encode("payload"));
    const binaryContent = createBinaryInputContent({
      mimeType: "application/octet-stream",
      data: encoded,
      filename: "payload.bin",
    });

    expect(binaryContent.mimeType).toBe("application/octet-stream");
    const decoded = decodeBinaryData(binaryContent.data ?? "");
    expect(new TextDecoder().decode(decoded)).toBe("payload");
  });

  it("normalizes string content into text items", () => {
    const normalized = normalizeInputContent("hello");
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual({ type: "text", text: "hello" });
  });
});
