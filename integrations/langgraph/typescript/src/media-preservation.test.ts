import { describe, expect, it } from "vitest";
import { UserMessage } from "@ag-ui/client";
import { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
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

describe("TypeScript video compatibility", () => {
  it.each([
    [
      "typed inline",
      {
        type: "video",
        source: { type: "data", value: "AAA=", mimeType: "video/mp4" },
        metadata: { filename: "clip.mp4" },
      },
      "data:video/mp4;base64,AAA=",
    ],
    [
      "typed data URL",
      {
        type: "video",
        source: { type: "url", value: "data:video/mp4;base64,AAA=" },
        metadata: { filename: "clip.mp4" },
      },
      "data:video/mp4;base64,AAA=",
    ],
    [
      "typed remote",
      {
        type: "video",
        source: {
          type: "url",
          value: "https://example.com/clip.mp4",
          mimeType: "video/mp4",
        },
        metadata: { filename: "clip.mp4" },
      },
      "https://example.com/clip.mp4",
    ],
  ])("retains the base image_url shape for %s video", (_label, item, url) => {
    const message: UserMessage = JSON.parse(
      JSON.stringify({ id: "video", role: "user", content: [item] }),
    );
    expect(aguiMessagesToLangChain([message])[0].content).toEqual([
      { type: "image_url", image_url: { url } },
    ]);
  });
});

// Images and video stay on `image_url`, a block with nowhere to carry a name
// that providers accept: `@langchain/openai` forwards an `image_url` block
// verbatim on Chat Completions, so any extra key on it (or inside it) reaches
// the provider request, which is what issue #2100 was about. Their filenames
// ride on the MESSAGE instead, in `additional_kwargs["ag-ui"].attachments`,
// which no provider formatter serializes.
describe("image and video filenames on image_url blocks", () => {
  const PNG = "iVBORw0KGgo=";
  const MP4 = "AAAAIGZ0eXA=";

  const userMessage = (content: unknown[]): UserMessage =>
    JSON.parse(JSON.stringify({ id: "named", role: "user", content }));

  const humanMessage = (
    content: unknown[],
    additional_kwargs?: unknown,
  ): LangGraphMessage =>
    ({
      id: "named",
      type: "human",
      content,
      ...(additional_kwargs === undefined ? {} : { additional_kwargs }),
    }) as unknown as LangGraphMessage;

  it.each([
    [
      "inline image",
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
        metadata: { filename: "sample.png" },
      },
      `data:image/png;base64,${PNG}`,
      "sample.png",
    ],
    [
      "remote image",
      {
        type: "image",
        source: { type: "url", value: "https://example.com/a.png" },
        metadata: { filename: "a.png" },
      },
      "https://example.com/a.png",
      "a.png",
    ],
    [
      "inline video",
      {
        type: "video",
        source: { type: "data", value: MP4, mimeType: "video/mp4" },
        metadata: { filename: "cedar-video.mp4" },
      },
      `data:video/mp4;base64,${MP4}`,
      "cedar-video.mp4",
    ],
    [
      "video data URL",
      {
        type: "video",
        source: { type: "url", value: `data:video/mp4;base64,${MP4}` },
        metadata: { filename: "clip.mp4" },
      },
      `data:video/mp4;base64,${MP4}`,
      "clip.mp4",
    ],
  ])(
    "records the %s filename on the message, not the block",
    (_label, item, url, filename) => {
      const [converted] = aguiMessagesToLangChain([
        userMessage([{ type: "text", text: "look" }, item]),
      ]);
      // The block itself is byte-identical to the unnamed shape.
      expect(converted.content).toEqual([
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url } },
      ]);
      expect(converted.additional_kwargs).toEqual({
        "ag-ui": { attachments: [{ index: 1, type: "image_url", filename }] },
      });
    },
  );

  it.each([
    ["no metadata", {}],
    ["empty filename", { metadata: { filename: "" } }],
    ["non-string filename", { metadata: { filename: 42 } }],
  ])("invents no carrier for an image or video with %s", (_label, extra) => {
    const [converted] = aguiMessagesToLangChain([
      userMessage([
        {
          type: "image",
          source: { type: "data", value: PNG, mimeType: "image/png" },
          ...extra,
        },
        {
          type: "video",
          source: { type: "data", value: MP4, mimeType: "video/mp4" },
          ...extra,
        },
      ]),
    ]);
    expect(converted).not.toHaveProperty("additional_kwargs");
    expect(langchainMessagesToAgui([converted])[0].content).toEqual([
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
      },
      {
        type: "video",
        source: { type: "data", value: MP4, mimeType: "video/mp4" },
      },
    ]);
  });

  it("keeps every name on its own part across a mixed attachment message", () => {
    const original = userMessage([
      { type: "text", text: "four attachments" },
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
        metadata: { filename: "sample.png" },
      },
      {
        type: "document",
        source: {
          type: "data",
          value: "JVBERi0=",
          mimeType: "application/pdf",
        },
        metadata: { filename: "sample.pdf" },
      },
      {
        type: "audio",
        source: { type: "data", value: "UklGRg==", mimeType: "audio/wav" },
        metadata: { filename: "sample.wav" },
      },
      {
        type: "video",
        source: { type: "data", value: MP4, mimeType: "video/mp4" },
        metadata: { filename: "cedar-video.mp4" },
      },
    ]);
    const [converted] = aguiMessagesToLangChain([original]);
    // PDF and WAV keep their names on their own standard blocks.
    expect(converted.content).toEqual([
      { type: "text", text: "four attachments" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      {
        type: "file",
        source_type: "base64",
        data: "JVBERi0=",
        mime_type: "application/pdf",
        metadata: { filename: "sample.pdf" },
      },
      {
        type: "audio",
        source_type: "base64",
        data: "UklGRg==",
        mime_type: "audio/wav",
        metadata: { filename: "sample.wav" },
      },
      { type: "image_url", image_url: { url: `data:video/mp4;base64,${MP4}` } },
    ]);
    expect(converted.additional_kwargs).toEqual({
      "ag-ui": {
        attachments: [
          { index: 1, type: "image_url", filename: "sample.png" },
          { index: 4, type: "image_url", filename: "cedar-video.mp4" },
        ],
      },
    });
    expect(langchainMessagesToAgui([converted])).toEqual([original]);
  });

  it("counts a dropped part out of the carrier index", () => {
    const [converted] = aguiMessagesToLangChain([
      userMessage([
        { type: "image", source: { type: "data", value: "" } },
        {
          type: "image",
          source: { type: "data", value: PNG, mimeType: "image/png" },
          metadata: { filename: "kept.png" },
        },
      ]),
    ]);
    expect(converted.content).toHaveLength(1);
    expect(converted.additional_kwargs).toEqual({
      "ag-ui": {
        attachments: [{ index: 0, type: "image_url", filename: "kept.png" }],
      },
    });
  });

  it("reads what the Python adapter stores: image carrier and a named video block", () => {
    const [restored] = langchainMessagesToAgui([
      humanMessage(
        [
          {
            type: "image_url",
            image_url: { url: "https://example.com/p.png" },
          },
          {
            type: "video",
            base64: MP4,
            mime_type: "video/mp4",
            filename: "py.mp4",
          },
        ],
        {
          "ag-ui": {
            attachments: [{ index: 0, type: "image_url", filename: "p.png" }],
          },
        },
      ),
    ]);
    expect(restored.content).toEqual([
      {
        type: "image",
        source: { type: "url", value: "https://example.com/p.png" },
        metadata: { filename: "p.png" },
      },
      {
        type: "video",
        source: { type: "data", value: MP4, mimeType: "video/mp4" },
        metadata: { filename: "py.mp4" },
      },
    ]);
  });

  it("reads a carrier nested by an older langchain-core message coercion", () => {
    // langchain-core before 0.3.60 folds a message dict's `additional_kwargs`
    // key into additional_kwargs instead of merging it.
    const [restored] = langchainMessagesToAgui([
      humanMessage(
        [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG}` },
          },
        ],
        {
          type: "human",
          additional_kwargs: {
            "ag-ui": {
              attachments: [{ index: 0, type: "image_url", filename: "n.png" }],
            },
          },
        },
      ),
    ]);
    expect(restored.content).toEqual([
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
        metadata: { filename: "n.png" },
      },
    ]);
  });

  it.each([
    ["a non-object additional_kwargs", "junk"],
    ["a non-object carrier", { "ag-ui": 7 }],
    ["non-array attachments", { "ag-ui": { attachments: {} } }],
    ["a non-object entry", { "ag-ui": { attachments: [null, "x"] } }],
    [
      "a non-integer index",
      {
        "ag-ui": {
          attachments: [{ index: "0", type: "image_url", filename: "x.png" }],
        },
      },
    ],
    [
      "a fractional index",
      {
        "ag-ui": {
          attachments: [{ index: 0.5, type: "image_url", filename: "x.png" }],
        },
      },
    ],
    [
      "an empty filename",
      {
        "ag-ui": {
          attachments: [{ index: 0, type: "image_url", filename: "" }],
        },
      },
    ],
    [
      "an entry for another block kind",
      {
        "ag-ui": {
          attachments: [{ index: 0, type: "file", filename: "x.png" }],
        },
      },
    ],
    [
      "an index past the content",
      {
        "ag-ui": {
          attachments: [{ index: 3, type: "image_url", filename: "x.png" }],
        },
      },
    ],
  ])("ignores %s without dropping the image", (_label, additional_kwargs) => {
    const [restored] = langchainMessagesToAgui([
      humanMessage(
        [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG}` },
          },
        ],
        additional_kwargs,
      ),
    ]);
    expect(restored.content).toEqual([
      {
        type: "image",
        source: { type: "data", value: PNG, mimeType: "image/png" },
      },
    ]);
  });

  it("does not let a carrier entry rename a standard block", () => {
    const [restored] = langchainMessagesToAgui([
      humanMessage(
        [
          {
            type: "file",
            source_type: "base64",
            data: "JVBERi0=",
            mime_type: "application/pdf",
            metadata: { filename: "real.pdf" },
          },
        ],
        {
          "ag-ui": {
            attachments: [
              { index: 0, type: "image_url", filename: "wrong.png" },
            ],
          },
        },
      ),
    ]);
    expect(restored.content).toEqual([
      {
        type: "document",
        source: {
          type: "data",
          value: "JVBERi0=",
          mimeType: "application/pdf",
        },
        metadata: { filename: "real.pdf" },
      },
    ]);
  });
});
