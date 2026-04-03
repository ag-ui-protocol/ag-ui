/**
 * Tests for resolveReasoningContent and resolveEncryptedReasoningContent.
 * Covers all supported AI provider formats including the Bedrock Converse API
 * fix for issue #1361.
 */

import { resolveReasoningContent, resolveEncryptedReasoningContent } from "./utils";

describe("resolveReasoningContent", () => {
  it("should handle Anthropic old format (thinking)", () => {
    const eventData = {
      chunk: {
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Let me think...");
    expect(result!.type).toBe("text");
    expect(result!.index).toBe(0);
  });

  it("should handle Anthropic old format with signature", () => {
    const eventData = {
      chunk: {
        content: [{ type: "thinking", thinking: "Deep thought", signature: "sig123", index: 1 }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result!.text).toBe("Deep thought");
    expect(result!.signature).toBe("sig123");
    expect(result!.index).toBe(1);
  });

  it("should handle LangChain new format (reasoning)", () => {
    const eventData = {
      chunk: {
        content: [{ type: "reasoning", reasoning: "Step 1..." }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Step 1...");
  });

  it("should handle OpenAI Responses API v1 format", () => {
    const eventData = {
      chunk: {
        content: [{ type: "reasoning", summary: [{ text: "Because X implies Y" }] }],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Because X implies Y");
  });

  it("should handle OpenAI legacy format via additional_kwargs", () => {
    const eventData = {
      chunk: {
        content: [],
        additional_kwargs: {
          reasoning: { summary: [{ text: "Legacy reasoning", index: 2 }] },
        },
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Legacy reasoning");
    expect(result!.index).toBe(2);
  });

  it("should handle Bedrock Converse API format (issue #1361)", () => {
    const eventData = {
      chunk: {
        content: [
          {
            type: "reasoning_content",
            reasoning_content: { type: "text", text: "Bedrock reasoning here" },
          },
        ],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Bedrock reasoning here");
    expect(result!.type).toBe("text");
  });

  it("should handle Bedrock Converse with index", () => {
    const eventData = {
      chunk: {
        content: [
          {
            type: "reasoning_content",
            reasoning_content: { type: "text", text: "Step 2", index: 3 },
          },
        ],
      },
    };
    const result = resolveReasoningContent(eventData);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(3);
  });

  it("should return null for empty content", () => {
    expect(resolveReasoningContent({ chunk: { content: [] } })).toBeNull();
  });

  it("should return null for null content", () => {
    expect(resolveReasoningContent({ chunk: { content: null } })).toBeNull();
  });

  it("should return null for unknown format", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "unknown", data: "stuff" }] } }),
    ).toBeNull();
  });

  it("should return null for regular text blocks", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "text", text: "Regular" }] } }),
    ).toBeNull();
  });

  it("should return null for empty thinking", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "thinking", thinking: "" }] } }),
    ).toBeNull();
  });

  it("should return null for empty reasoning", () => {
    expect(
      resolveReasoningContent({ chunk: { content: [{ type: "reasoning", reasoning: "" }] } }),
    ).toBeNull();
  });
});

describe("resolveEncryptedReasoningContent", () => {
  it("should extract redacted_thinking data", () => {
    const eventData = {
      chunk: {
        content: [{ type: "redacted_thinking", data: "encrypted_data_here" }],
      },
    };
    expect(resolveEncryptedReasoningContent(eventData)).toBe("encrypted_data_here");
  });

  it("should return null for non-redacted content", () => {
    expect(
      resolveEncryptedReasoningContent({
        chunk: { content: [{ type: "thinking", thinking: "visible" }] },
      }),
    ).toBeNull();
  });

  it("should return null for empty content", () => {
    expect(resolveEncryptedReasoningContent({ chunk: { content: [] } })).toBeNull();
  });

  it("should return null for null chunk", () => {
    expect(resolveEncryptedReasoningContent({ chunk: null })).toBeNull();
  });

  it("should return null for redacted_thinking without data", () => {
    expect(
      resolveEncryptedReasoningContent({
        chunk: { content: [{ type: "redacted_thinking" }] },
      }),
    ).toBeNull();
  });
});
