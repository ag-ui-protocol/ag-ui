import { describe, expect, it } from "vitest";
import { UserMessage } from "@ag-ui/client";
import { aguiMessagesToLangChain, langchainMessagesToAgui } from "./utils";

describe("non-image media preservation", () => {
  it("preserves a supplied remote filename matching the inline default", () => {
    const message: UserMessage = {
      id: "remote-file",
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "url",
            value: "https://example.com/file",
            mimeType: "application/pdf",
          },
          metadata: { filename: "attachment.pdf" },
        },
      ],
    };
    expect(langchainMessagesToAgui(aguiMessagesToLangChain([message]))).toEqual(
      [message],
    );
  });

  it.each([
    ["audio", "audio/ogg", "audio"],
    ["video", "video/mp4", "video"],
    ["document", "text/plain", "file"],
  ] as const)(
    "preserves %s for inline bytes, data URLs and remote URLs",
    (type, mimeType, blockType) => {
      for (const source of [
        { type: "data", value: "AAA=", mimeType },
        { type: "url", value: `data:${mimeType};base64,AAA=`, mimeType },
        { type: "url", value: "https://example.com/media", mimeType },
      ] as const) {
        const message: UserMessage = {
          id: "media",
          role: "user",
          content: [{ type, source, metadata: { filename: "original.bin" } }],
        };
        const converted = aguiMessagesToLangChain([message]);
        const remote = source.value.startsWith("https:");
        expect(converted[0].content).toEqual([
          {
            type: blockType,
            source_type: remote ? "url" : "base64",
            ...(remote ? { url: source.value } : { data: "AAA=" }),
            mime_type: mimeType,
            metadata: { filename: "original.bin" },
          },
        ]);
        expect(langchainMessagesToAgui(converted)[0]).toEqual({
          ...message,
          content: [
            {
              type,
              source: remote
                ? source
                : { type: "data", value: "AAA=", mimeType },
              metadata: { filename: "original.bin" },
            },
          ],
        });
      }
    },
  );
});
