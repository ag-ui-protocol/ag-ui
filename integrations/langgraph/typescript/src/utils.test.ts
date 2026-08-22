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
} from "@ag-ui/client";
// Imported at the TOP LEVEL, not dynamically inside the boundary tests below.
// `@langchain/openai` pulls a large module graph, and on a cold CI runner the
// first `await import()` of it took 7.9s — charged to the test that happened to
// run first, which then failed vitest's 5s default while the later ones passed
// on the warm cache. File-level import time is not charged to a test.
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { aguiMessagesToLangChain, langchainMessagesToAgui, resolveReasoningContent } from "./utils";

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
      // An `audio` block, NOT `image_url`: providers validate the block kind, so
      // audio announced as an image is rejected outright.
      expect(content[1]).toEqual({
        type: "audio",
        url: "https://example.com/audio.mp3",
      });
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
      expect(content[1]).toEqual({
        type: "video",
        data: "dmlkZW9kYXRh",
        mimeType: "video/mp4",
      });
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
      expect(content[1]).toEqual({
        type: "file",
        url: "https://example.com/doc.pdf",
      });
    });

    it("should send an attached PDF as a file block, not an image", () => {
      // THE REGRESSION THIS GUARDS. A PDF handed to a provider as `image_url` —
      // with `application/pdf` sitting inside the data URL — is rejected on the
      // block kind:
      //
      //     BadRequestError: 400 - Invalid MIME type. Only image types are
      //     supported. (code: invalid_image_format)
      //
      // and the exception kills the run rather than degrading it.
      const aguiMessage: UserMessage = {
        id: "test-doc-data",
        role: "user",
        content: [
          { type: "text", text: "Summarize this invoice" },
          {
            type: "document",
            source: {
              type: "data",
              value: "JVBERi0xLjQK",
              mimeType: "application/pdf",
            },
            metadata: { filename: "invoice-q2.pdf" },
          } as DocumentInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content[1]).toEqual({
        type: "file",
        data: "JVBERi0xLjQK",
        mimeType: "application/pdf",
        // NATIVE LangChain.js field names, and `filename` nested under
        // `metadata` — that is where `@langchain/openai`'s
        // `getRequiredFilenameFromMetadata` looks, and it substitutes the
        // placeholder `LC_AUTOGENERATED` when it is absent. Python's
        // `base64` / `mime_type` / top-level `filename` satisfy none of the JS
        // converter's reads, so a block wearing those names is dropped.
        metadata: { filename: "invoice-q2.pdf" },
      });
      // Issue #2100 restated rather than dropped. The block DOES carry a
      // `metadata` key now, because that is the native home for the filename —
      // but only `filename`, never AG-UI's metadata object wholesale, which is
      // what made strict providers 400.
      expect(Object.keys(content[1].metadata)).toEqual(["filename"]);
    });

    it("should keep a document a document across the LangChain round trip", () => {
      // This is the MESSAGES_SNAPSHOT path. A block kind the return leg does not
      // understand is an attachment that disappears from the thread on the next
      // snapshot: the file was sent, the model read it, and a reopened thread
      // shows a bare line of text.
      const aguiMessage: UserMessage = {
        id: "test-doc-roundtrip",
        role: "user",
        content: [
          { type: "text", text: "Summarize this invoice" },
          {
            type: "document",
            source: {
              type: "data",
              value: "JVBERi0xLjQK",
              mimeType: "application/pdf",
            },
            metadata: { filename: "invoice-q2.pdf" },
          } as DocumentInputContent,
        ],
      };

      const roundTripped = langchainMessagesToAgui(
        aguiMessagesToLangChain([aguiMessage])
      );

      const content = (roundTripped[0] as UserMessage).content as Array<any>;
      expect(content[1]).toEqual({
        type: "document",
        source: {
          type: "data",
          value: "JVBERi0xLjQK",
          mimeType: "application/pdf",
        },
        metadata: { filename: "invoice-q2.pdf" },
      });
    });

    it("should send a legacy binary PDF as a file block", () => {
      // `BinaryInputContent` is deprecated but still accepted, and a deprecated
      // path that 400s is not meaningfully more supported than one that raises.
      const aguiMessage: UserMessage = {
        id: "test-binary-pdf",
        role: "user",
        content: [
          { type: "text", text: "Summarize this" },
          {
            type: "binary",
            mimeType: "application/pdf",
            data: "JVBERi0xLjQK",
            filename: "legacy-invoice.pdf",
          } as BinaryInputContent,
        ],
      };

      const lcMessages = aguiMessagesToLangChain([aguiMessage]);

      const content = lcMessages[0].content as Array<any>;
      expect(content[1]).toEqual({
        type: "file",
        data: "JVBERi0xLjQK",
        mimeType: "application/pdf",
        metadata: { filename: "legacy-invoice.pdf" },
      });
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

  // ── Provider boundary ────────────────────────────────────────────────────
  //
  // The tests above assert the SHAPE this adapter emits. On their own that is
  // exactly the trap that let the wrong shape ship: a converter and its tests
  // agreeing on an invented schema look identical to a correct one. These tests
  // hand the emitted blocks to the real `@langchain/openai` translator and read
  // what lands on the wire, with a stub `fetch` so nothing leaves the process.
  describe("provider boundary (@langchain/openai)", () => {
    /** Convert through ChatOpenAI and return the outgoing content parts. */
    async function partsOnTheWire(blocks: unknown[]): Promise<any[]> {
      let body: any;
      const model = new ChatOpenAI({
        apiKey: "test-not-used",
        model: "gpt-4o-mini",
        configuration: {
          fetch: async (_url: any, init: any) => {
            body = JSON.parse(init.body);
            return new Response(
              JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                created: 0,
                model: "gpt-4o-mini",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "ok" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      });

      await model.invoke([
        new HumanMessage({
          content: [{ type: "text", text: "hi" }, ...blocks] as any,
          // Selects the v1 conversion path in `@langchain/openai`, which is the
          // one that reads `contentBlocks` and translates standard media blocks.
          response_metadata: { output_version: "v1" },
        }),
      ]);

      return body.messages[0].content;
    }

    it("carries an emitted PDF block to OpenAI as a file part", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-pdf",
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
            metadata: { filename: "invoice-q2.pdf" },
          } as DocumentInputContent,
        ],
      };

      const emitted = (aguiMessagesToLangChain([aguiMessage])[0].content as any[]).filter(
        (b) => b.type !== "text",
      );
      const parts = await partsOnTheWire(emitted);

      expect(parts).toEqual([
        { type: "text", text: "hi" },
        {
          type: "file",
          file: {
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            // The real filename, NOT the `LC_AUTOGENERATED` placeholder the
            // translator substitutes when it cannot find one.
            filename: "invoice-q2.pdf",
          },
        },
      ]);
    });

    it("carries an emitted audio block to OpenAI as an input_audio part", async () => {
      const aguiMessage: UserMessage = {
        id: "boundary-audio",
        role: "user",
        content: [
          {
            type: "audio",
            source: { type: "data", value: "SGVsbG8=", mimeType: "audio/wav" },
          } as AudioInputContent,
        ],
      };

      const emitted = (aguiMessagesToLangChain([aguiMessage])[0].content as any[]).filter(
        (b) => b.type !== "text",
      );
      const parts = await partsOnTheWire(emitted);

      expect(parts[1]).toEqual({
        type: "input_audio",
        input_audio: { data: "SGVsbG8=", format: "wav" },
      });
    });

    it("would DROP a Python-shaped block — the regression this guards", async () => {
      // Pinning the failure mode, so the reason for the JS field names cannot be
      // refactored away by someone reading the Python adapter and "aligning"
      // them. `base64` / `mime_type` / top-level `filename` satisfy none of the
      // JS translator's reads, so it returns undefined and the part is skipped
      // — no error, no warning, attachment gone.
      const parts = await partsOnTheWire([
        {
          type: "file",
          base64: "JVBERi0xLjQK",
          mime_type: "application/pdf",
          filename: "invoice-q2.pdf",
        },
      ]);

      expect(parts).toEqual([{ type: "text", text: "hi" }]);
    });
  });

  // ── Native LangChain.js blocks on the way back ───────────────────────────
  describe("langchainMessagesToAgui with native LangChain.js blocks", () => {
    it("accepts a native JS file block", () => {
      const agui = langchainMessagesToAgui([
        {
          id: "native-file",
          type: "human",
          content: [
            { type: "text", text: "Summarize this" },
            {
              type: "file",
              data: "JVBERi0xLjQK",
              mimeType: "application/pdf",
              metadata: { filename: "invoice-q2.pdf" },
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[1]).toEqual({
        type: "document",
        source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
        metadata: { filename: "invoice-q2.pdf" },
      });
    });

    it("keeps MIME type and filename on a native JS file block by url", () => {
      const agui = langchainMessagesToAgui([
        {
          id: "native-url",
          type: "human",
          content: [
            {
              type: "file",
              url: "https://example.com/doc.pdf",
              mimeType: "application/pdf",
              metadata: { filename: "doc.pdf" },
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[0]).toEqual({
        type: "document",
        source: { type: "url", value: "https://example.com/doc.pdf", mimeType: "application/pdf" },
        metadata: { filename: "doc.pdf" },
      });
    });

    it("still accepts a Python-shaped block, because the graph may be Python", () => {
      // This package drives a LangGraph server through
      // `@langchain/langgraph-sdk`, and that server is usually the Python one,
      // so a graph's own messages come back in Python's field names. Refusing
      // them would drop the attachment from MESSAGES_SNAPSHOT — the same bug,
      // mirrored onto the return leg.
      const agui = langchainMessagesToAgui([
        {
          id: "python-shaped",
          type: "human",
          content: [
            {
              type: "file",
              base64: "JVBERi0xLjQK",
              mime_type: "application/pdf",
              filename: "invoice-q2.pdf",
            },
          ],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content[0]).toEqual({
        type: "document",
        source: { type: "data", value: "JVBERi0xLjQK", mimeType: "application/pdf" },
        metadata: { filename: "invoice-q2.pdf" },
      });
    });

    it("drops a fileId-only block loudly rather than inventing a source", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agui = langchainMessagesToAgui([
        {
          id: "file-id-only",
          type: "human",
          content: [{ type: "file", fileId: "file-abc123", mimeType: "application/pdf" }],
        } as unknown as LangGraphMessage,
      ]);

      const content = (agui[0] as UserMessage).content as Array<any>;
      expect(content).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Dropping file block"));
      warn.mockRestore();
    });
  });
});

describe("resolveReasoningContent - DeepSeek-style reasoning_content", () => {
  it("should return LangGraphReasoning when reasoning_content is a non-empty string", () => {
    const eventData = {
      chunk: {
        content: null,
        additional_kwargs: { reasoning_content: "thinking step by step" },
      },
    };

    const result = resolveReasoningContent(eventData);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("text");
    expect(result!.text).toBe("thinking step by step");
    expect(result!.index).toBe(0);
  });

  it("should return null when reasoning_content is empty string", () => {
    const eventData = {
      chunk: {
        content: null,
        additional_kwargs: { reasoning_content: "" },
      },
    };

    expect(resolveReasoningContent(eventData)).toBeNull();
  });

  it("should return null when reasoning_content is not present", () => {
    const eventData = {
      chunk: {
        content: null,
        additional_kwargs: { some_other_key: "value" },
      },
    };

    expect(resolveReasoningContent(eventData)).toBeNull();
  });

  it("should prioritize content block formats over additional_kwargs.reasoning_content", () => {
    const eventData = {
      chunk: {
        content: [{ type: "thinking", thinking: "from content block" }],
        additional_kwargs: { reasoning_content: "from additional_kwargs" },
      },
    };

    const result = resolveReasoningContent(eventData);

    expect(result).not.toBeNull();
    expect(result!.text).toBe("from content block");
  });
});
