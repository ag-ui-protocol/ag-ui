/**
 * Tests for multimodal message conversion between AG-UI and LangChain formats.
 */

import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import {
  Message,
  UserMessage,
  TextInputContent,
  BinaryInputContent,
  ImageInputContent,
  AudioInputContent,
  VideoInputContent,
  DocumentInputContent,
  InputContent,
} from "@ag-ui/client";
import { aguiMessagesToLangChain, langchainMessagesToAgui, AGUI_TYPE_KEY } from "./utils";

describe("Multimodal Message Conversion", () => {
  describe("aguiMessagesToLangChain", () => {
    it("should convert text-only AG-UI message to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-1",
        role: "user",
        content: "Hello, world!",
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(lcMessages[0].type).toBe("human");
      expect(lcMessages[0].content).toBe("Hello, world!");
      expect(lcMessages[0].id).toBe("test-1");
    });

    it("should convert ImageInputContent with URL source to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-img-url",
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "image",
            source: {
              type: "url",
              value: "https://example.com/photo.jpg",
            },
          } as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(lcMessages[0].type).toBe("human");
      expect(Array.isArray(lcMessages[0].content)).toBe(true);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      expect(content[0].type).toBe("text");
      expect(content[0].text).toBe("What's in this image?");

      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/photo.jpg");
    });

    it("should convert ImageInputContent with data source to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-img-data",
        role: "user",
        content: [
          { type: "text", text: "Analyze this" },
          {
            type: "image",
            source: {
              type: "data",
              value: "iVBORw0KGgoAAAANSUhEUgAAAAUA",
              mimeType: "image/png",
            },
          } as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(Array.isArray(lcMessages[0].content)).toBe(true);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      const imageContent = content[1];
      expect(imageContent.type).toBe("image_url");
      expect(imageContent.image_url.url).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"
      );
    });

    it("should convert AudioInputContent to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-audio",
        role: "user",
        content: [
          { type: "text", text: "Transcribe this audio" },
          {
            type: "audio",
            source: {
              type: "url",
              value: "https://example.com/audio.mp3",
            },
          } as AudioInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/audio.mp3");
    });

    it("should convert VideoInputContent to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-video",
        role: "user",
        content: [
          { type: "text", text: "Describe this video" },
          {
            type: "video",
            source: {
              type: "data",
              value: "dmlkZW9kYXRh",
              mimeType: "video/mp4",
            },
          } as VideoInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe(
        "data:video/mp4;base64,dmlkZW9kYXRh"
      );
    });

    it("should convert DocumentInputContent to LangChain", () => {
      const aguiMessage: UserMessage = {
        id: "test-doc",
        role: "user",
        content: [
          { type: "text", text: "Summarize this document" },
          {
            type: "document",
            source: {
              type: "url",
              value: "https://example.com/doc.pdf",
            },
          } as DocumentInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);
      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/doc.pdf");
    });

    it("should handle BinaryInputContent for backwards compatibility", () => {
      const aguiMessage: UserMessage = {
        id: "test-binary-compat",
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            url: "https://example.com/photo.jpg",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(2);

      expect(content[1].type).toBe("image_url");
      expect(content[1].image_url.url).toBe("https://example.com/photo.jpg");
    });

    it("should handle BinaryInputContent with base64 data for backwards compat", () => {
      const aguiMessage: UserMessage = {
        id: "test-binary-data",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAUA",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("image_url");
      expect(content[0].image_url.url).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"
      );
    });
  });

  describe("langchainMessagesToAgui", () => {
    it("should convert text-only LangChain message to AG-UI", () => {
      const lcMessage: LangGraphMessage = {
        id: "test-4",
        type: "human",
        content: "Hello from LangChain",
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      expect(aguiMessages).toHaveLength(1);
      expect(aguiMessages[0].role).toBe("user");
      expect(aguiMessages[0].content).toBe("Hello from LangChain");
    });

    it("should convert LangChain image_url to ImageInputContent with URL source", () => {
      const lcMessage: LangGraphMessage = {
        id: "test-lc-url",
        type: "human",
        content: [
          { type: "text", text: "What do you see?" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/image.jpg" },
          },
        ] as any,
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      expect(aguiMessages).toHaveLength(1);
      expect(aguiMessages[0].role).toBe("user");
      expect(Array.isArray(aguiMessages[0].content)).toBe(true);

      const content = aguiMessages[0].content as Array<TextInputContent | ImageInputContent>;
      expect(content).toHaveLength(2);

      // Check text content
      expect(content[0].type).toBe("text");
      expect((content[0] as TextInputContent).text).toBe("What do you see?");

      // Check image content - should now be ImageInputContent with URL source
      const imageContent = content[1] as ImageInputContent;
      expect(imageContent.type).toBe("image");
      expect(imageContent.source.type).toBe("url");
      expect((imageContent.source as { type: "url"; value: string }).value).toBe(
        "https://example.com/image.jpg"
      );
    });

    it("should convert LangChain data URL to ImageInputContent with data source", () => {
      const lcMessage: LangGraphMessage = {
        id: "test-lc-data",
        type: "human",
        content: [
          { type: "text", text: "Check this out" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo" },
          },
        ] as any,
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      expect(aguiMessages).toHaveLength(1);
      expect(Array.isArray(aguiMessages[0].content)).toBe(true);

      const content = aguiMessages[0].content as Array<TextInputContent | ImageInputContent>;
      expect(content).toHaveLength(2);

      // Check that data URL was parsed correctly into ImageInputContent
      const imageContent = content[1] as ImageInputContent;
      expect(imageContent.type).toBe("image");
      expect(imageContent.source.type).toBe("data");

      const dataSource = imageContent.source as { type: "data"; value: string; mimeType: string };
      expect(dataSource.value).toBe("iVBORw0KGgo");
      expect(dataSource.mimeType).toBe("image/png");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty content arrays", () => {
      const aguiMessage: UserMessage = {
        id: "test-7",
        role: "user",
        content: [],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      expect(Array.isArray(lcMessages[0].content)).toBe(true);
      expect((lcMessages[0].content as Array<any>)).toHaveLength(0);
    });

    it("should handle BinaryInputContent with only id for backwards compat", () => {
      const aguiMessage: UserMessage = {
        id: "test-8",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/jpeg",
            id: "img-123",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("image_url");
      expect(content[0].image_url.url).toBe("img-123");
    });

    it("should skip media content with unknown source type", () => {
      const aguiMessage: UserMessage = {
        id: "test-unknown-source",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "image",
            source: { type: "unknown" as any, value: "foo" },
          } as any,
        ],
      };
      const lcMessages = aguiMessagesToLangChain([aguiMessage]);
      const content = lcMessages[0].content as Array<any>;
      // Only text should remain, image with unknown source should be dropped
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
    });

    it("should skip binary content without any source", () => {
      const aguiMessage: UserMessage = {
        id: "test-9",
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "binary",
            mimeType: "image/jpeg",
            // No url, data, or id
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      expect(lcMessages).toHaveLength(1);
      const content = lcMessages[0].content as Array<any>;
      // Binary content should be skipped, only text remains
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
    });
  });

  describe("Metadata + media type round-trip", () => {
    it("forward preserves metadata and tags type", () => {
      const aguiMessage: UserMessage = {
        id: "fwd-image",
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", value: "https://example.com/photo.jpg" },
            metadata: { alt: "a cat", id: 42 },
          } as ImageInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const block = (lcMessages[0].content as Array<any>)[0];
      expect(block.type).toBe("image_url");
      expect(block.metadata).toEqual({ alt: "a cat", id: 42, [AGUI_TYPE_KEY]: "image" });
    });

    it("forward embeds __agui_type in metadata for non-image media", () => {
      const aguiMessage: UserMessage = {
        id: "fwd-audio",
        role: "user",
        content: [
          {
            type: "audio",
            source: { type: "url", value: "https://example.com/a.mp3" },
            metadata: { duration: 12 },
          } as AudioInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const block = (lcMessages[0].content as Array<any>)[0];
      expect(block.type).toBe("image_url");
      expect(block.metadata).toEqual({ duration: 12, [AGUI_TYPE_KEY]: "audio" });
    });

    it("reverse restores type + metadata from a tagged block", () => {
      const lcMessage: LangGraphMessage = {
        id: "rev-tagged",
        type: "human",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.com/v.mp4" },
            metadata: { fps: 30, [AGUI_TYPE_KEY]: "video" },
          },
        ] as any,
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      const part = (aguiMessages[0].content as Array<any>)[0];
      expect(part.type).toBe("video");
      expect(part.source).toEqual({ type: "url", value: "https://example.com/v.mp4" });
      expect(part.metadata).toEqual({ fps: 30 });
    });

    it("reverse falls back to image for untagged blocks", () => {
      const lcMessage: LangGraphMessage = {
        id: "rev-untagged",
        type: "human",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
        ] as any,
      };

      const aguiMessages = langchainMessagesToAgui([lcMessage]);

      const part = (aguiMessages[0].content as Array<any>)[0];
      expect(part.type).toBe("image");
      expect(part.metadata).toBeUndefined();
    });

    it.each(["image", "audio", "video", "document"] as const)(
      "round-trips %s through LangChain preserving type, source, and metadata",
      (mediaType) => {
        const source = { type: "data", value: "ZGF0YQ==", mimeType: `${mediaType}/x` } as const;
        const metadata = { kind: mediaType, n: 7 };
        const original: UserMessage = {
          id: `rt-${mediaType}`,
          role: "user",
          content: [{ type: mediaType, source, metadata } as InputContent],
        };

        const lcMessages = aguiMessagesToLangChain([original]);
        const roundTripped = langchainMessagesToAgui([
          { id: original.id, type: "human", content: lcMessages[0].content } as LangGraphMessage,
        ]);

        const part = (roundTripped[0].content as Array<any>)[0];
        expect(part.type).toBe(mediaType);
        expect(part.source).toEqual(source);
        expect(part.metadata).toEqual(metadata);
      }
    );
  });
});
