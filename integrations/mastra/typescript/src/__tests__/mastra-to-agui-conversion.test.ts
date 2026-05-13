import { convertAGUIMessagesToMastra, convertMastraMessagesToAGUI } from "../utils";

describe("convertMastraMessagesToAGUI", () => {
  describe("user messages", () => {
    it("converts text parts to string content", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "Hello world" }],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toEqual([
        { id: "msg-1", role: "user", content: "Hello world" },
      ]);
    });

    it("joins multiple text parts with newlines", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [
              { type: "text", text: "First part" },
              { type: "text", text: "Second part" },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toEqual([
        { id: "msg-1", role: "user", content: "First part\nSecond part" },
      ]);
    });

    it("returns empty string for messages with no text parts", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: { format: 2, parts: [] },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toEqual([
        { id: "msg-1", role: "user", content: "" },
      ]);
    });
  });

  describe("assistant messages", () => {
    it("converts text-only assistant messages", () => {
      const messages = [
        {
          id: "msg-2",
          role: "assistant",
          content: {
            format: 2,
            parts: [{ type: "text", text: "I can help you with that." }],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toEqual([
        {
          id: "msg-2",
          role: "assistant",
          content: "I can help you with that.",
          toolCalls: undefined,
        },
      ]);
    });

    it("converts assistant messages with tool invocations (result state)", () => {
      const messages = [
        {
          id: "msg-2",
          role: "assistant",
          content: {
            format: 2,
            parts: [
              { type: "text", text: "Let me check that." },
              {
                type: "tool-invocation",
                toolCallId: "call-1",
                toolName: "get_weather",
                args: { city: "Paris" },
                state: "result",
                result: { temperature: 22, unit: "celsius" },
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      // Should produce assistant message + tool result message
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: "msg-2",
        role: "assistant",
        content: "Let me check that.",
      });
      expect(result[0]).toHaveProperty("toolCalls");
      expect((result[0] as any).toolCalls[0]).toMatchObject({
        id: "call-1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ city: "Paris" }),
        },
      });
      expect(result[1]).toMatchObject({
        role: "tool",
        content: JSON.stringify({ temperature: 22, unit: "celsius" }),
        toolCallId: "call-1",
      });
    });

    it("converts tool-call parts (non-invocation format)", () => {
      const messages = [
        {
          id: "msg-2",
          role: "assistant",
          content: {
            format: 2,
            parts: [
              {
                type: "tool-call",
                toolCallId: "call-2",
                toolName: "search",
                args: { query: "test" },
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "msg-2",
        role: "assistant",
      });
      expect((result[0] as any).toolCalls[0]).toMatchObject({
        id: "call-2",
        type: "function",
        function: {
          name: "search",
          arguments: JSON.stringify({ query: "test" }),
        },
      });
    });
  });

  describe("system messages", () => {
    it("skips system messages", () => {
      const messages = [
        {
          id: "msg-sys",
          role: "system",
          content: {
            format: 2,
            parts: [{ type: "text", text: "You are a helpful assistant." }],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toEqual([]);
    });
  });

  describe("mixed conversations", () => {
    it("converts a full conversation with user, assistant, and tool messages", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "What's the weather?" }],
          },
        },
        {
          id: "msg-2",
          role: "assistant",
          content: {
            format: 2,
            parts: [
              { type: "text", text: "Checking..." },
              {
                type: "tool-invocation",
                toolCallId: "call-1",
                toolName: "get_weather",
                args: { city: "NYC" },
                state: "result",
                result: "Sunny, 25°C",
              },
            ],
          },
        },
        {
          id: "msg-3",
          role: "assistant",
          content: {
            format: 2,
            parts: [{ type: "text", text: "It's sunny and 25°C in NYC." }],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toHaveLength(4); // user + assistant+tool + assistant
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
      expect(result[2].role).toBe("tool");
      expect(result[3].role).toBe("assistant");
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      expect(convertMastraMessagesToAGUI([])).toEqual([]);
    });

    it("handles missing parts gracefully", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: { format: 2 } as any, // no parts
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toEqual([
        { id: "msg-1", role: "user", content: "" },
      ]);
    });

    it("preserves original message IDs", () => {
      const messages = [
        {
          id: "original-id-123",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "Hello" }],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result[0].id).toBe("original-id-123");
    });

    it("handles tool result as string", () => {
      const messages = [
        {
          id: "msg-2",
          role: "assistant",
          content: {
            format: 2,
            parts: [
              {
                type: "tool-invocation",
                toolCallId: "call-1",
                toolName: "get_weather",
                args: {},
                state: "result",
                result: "sunny",
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result[1]).toMatchObject({
        role: "tool",
        content: "sunny",
        toolCallId: "call-1",
      });
    });
  });

  describe("multimodal content", () => {
    it("decodes user image parts (forward-converter shape) back to InputContent", () => {
      // This is the exact shape `convertAGUIMessagesToMastra` emits for an
      // AG-UI image: { type: "image", image: "data:<mime>;base64,<raw>" }.
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [
              { type: "text", text: "Look at this:" },
              {
                type: "image",
                image: "data:image/png;base64,BASE64PNG",
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "msg-1",
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          {
            type: "image",
            source: { type: "data", value: "BASE64PNG", mimeType: "image/png" },
          },
        ],
      });
    });

    it("decodes audio/video/document file parts with data URLs back to raw base64", () => {
      // Forward-converter shape: { type: "file", mimeType, data: "data:...;base64,<raw>" }
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [
              {
                type: "file",
                mimeType: "audio/mp3",
                data: "data:audio/mp3;base64,AUDIODATA",
              },
              {
                type: "file",
                mimeType: "video/mp4",
                data: "data:video/mp4;base64,VIDEODATA",
              },
              {
                type: "file",
                mimeType: "application/pdf",
                data: "data:application/pdf;base64,PDFDATA",
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result).toHaveLength(1);
      expect((result[0] as any).content).toEqual([
        {
          type: "audio",
          source: { type: "data", value: "AUDIODATA", mimeType: "audio/mp3" },
        },
        {
          type: "video",
          source: { type: "data", value: "VIDEODATA", mimeType: "video/mp4" },
        },
        {
          type: "document",
          source: { type: "data", value: "PDFDATA", mimeType: "application/pdf" },
        },
      ]);
    });

    it("uses url source when file part has a url", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [
              {
                type: "file",
                mimeType: "image/jpeg",
                url: "https://example.com/cat.jpg",
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect((result[0] as any).content).toEqual([
        {
          type: "image",
          source: {
            type: "url",
            value: "https://example.com/cat.jpg",
            mimeType: "image/jpeg",
          },
        },
      ]);
    });

    it("round-trips AG-UI image(data) → Mastra → AG-UI snapshot", () => {
      const original = [
        {
          id: "msg-1",
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Here's an image:" },
            {
              type: "image" as const,
              source: {
                type: "data" as const,
                value: "BASE64PNG",
                mimeType: "image/png",
              },
            },
          ],
        },
      ];

      // AG-UI → Mastra CoreMessage
      const coreMessages = convertAGUIMessagesToMastra(original as any);

      // Simulate storage in Mastra V2 format. Forward converter produced
      // `{ type: "image", image: "data:image/png;base64,BASE64PNG" }`, and
      // that's exactly what ends up on the stored MastraDBMessage parts array.
      const storedContent = coreMessages[0].content;
      const storedParts = Array.isArray(storedContent) ? storedContent : [];
      const stored = [
        {
          id: "msg-1",
          role: "user",
          content: { format: 2, parts: storedParts },
        },
      ];

      const snapshot = convertMastraMessagesToAGUI(stored);

      expect(snapshot[0]).toEqual({
        id: "msg-1",
        role: "user",
        content: [
          { type: "text", text: "Here's an image:" },
          {
            type: "image",
            source: { type: "data", value: "BASE64PNG", mimeType: "image/png" },
          },
        ],
      });
    });

    it("round-trips AG-UI audio/video/document(data) → Mastra → AG-UI snapshot", () => {
      const original = [
        {
          id: "msg-1",
          role: "user" as const,
          content: [
            {
              type: "audio" as const,
              source: {
                type: "data" as const,
                value: "AUDIODATA",
                mimeType: "audio/mp3",
              },
            },
            {
              type: "video" as const,
              source: {
                type: "data" as const,
                value: "VIDEODATA",
                mimeType: "video/mp4",
              },
            },
            {
              type: "document" as const,
              source: {
                type: "data" as const,
                value: "PDFDATA",
                mimeType: "application/pdf",
              },
            },
          ],
        },
      ];

      const coreMessages = convertAGUIMessagesToMastra(original as any);
      const storedContent = coreMessages[0].content;
      const storedParts = Array.isArray(storedContent) ? storedContent : [];
      const stored = [
        {
          id: "msg-1",
          role: "user",
          content: { format: 2, parts: storedParts },
        },
      ];

      const snapshot = convertMastraMessagesToAGUI(stored);

      expect((snapshot[0] as any).content).toEqual([
        {
          type: "audio",
          source: { type: "data", value: "AUDIODATA", mimeType: "audio/mp3" },
        },
        {
          type: "video",
          source: { type: "data", value: "VIDEODATA", mimeType: "video/mp4" },
        },
        {
          type: "document",
          source: { type: "data", value: "PDFDATA", mimeType: "application/pdf" },
        },
      ]);
    });

    it("keeps plain string content for text-only user messages", () => {
      const messages = [
        {
          id: "msg-1",
          role: "user",
          content: {
            format: 2,
            parts: [{ type: "text", text: "just text" }],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result[0]).toEqual({
        id: "msg-1",
        role: "user",
        content: "just text",
      });
    });
  });

  describe("stable IDs", () => {
    it("produces identical output across repeated calls with the same input", () => {
      const messages = [
        {
          id: "msg-assistant",
          role: "assistant",
          content: {
            format: 2,
            parts: [
              { type: "text", text: "Running tool" },
              {
                type: "tool-invocation",
                toolCallId: "call-abc",
                toolName: "search",
                args: { q: "x" },
                state: "result",
                result: { hits: 3 },
              },
              {
                type: "tool-invocation",
                toolCallId: "call-def",
                toolName: "lookup",
                args: { id: "42" },
                state: "result",
                result: "ok",
              },
            ],
          },
        },
      ];

      const first = convertMastraMessagesToAGUI(messages);
      const second = convertMastraMessagesToAGUI(messages);

      expect(first).toEqual(second);
    });

    it("derives tool result message IDs from parent message + toolCallId", () => {
      const messages = [
        {
          id: "msg-assistant",
          role: "assistant",
          content: {
            format: 2,
            parts: [
              {
                type: "tool-invocation",
                toolCallId: "call-abc",
                toolName: "search",
                args: {},
                state: "result",
                result: "ok",
              },
            ],
          },
        },
      ];

      const result = convertMastraMessagesToAGUI(messages);

      expect(result[1]).toMatchObject({
        id: "msg-assistant:call-abc:result",
        role: "tool",
        toolCallId: "call-abc",
      });
    });
  });
});
