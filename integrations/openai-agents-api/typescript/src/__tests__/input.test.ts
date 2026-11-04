import { describe, expect, it } from "vitest";
import {
  contextPart,
  splitFirstContact,
  toInputParts,
  toToolOutput,
  undeliveredUserMessages,
} from "../input";
import { linkCitations } from "../translate";
import { fingerprintTools, mergeTools } from "../tools";

describe("input conversion", () => {
  it("converts text and images, and notes attachments the agent cannot read", () => {
    expect(
      toInputParts([
        { type: "text", text: "Look" },
        {
          type: "image",
          source: { type: "data", value: "AAAA", mimeType: "image/png" },
        },
        {
          type: "image",
          source: { type: "url", value: "https://example.com/a.jpg" },
        },
        {
          type: "audio",
          source: { type: "url", value: "https://example.com/a.mp3" },
        },
      ] as never),
    ).toEqual([
      { type: "input_text", text: "Look" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_image", image_url: "https://example.com/a.jpg" },
      {
        type: "input_text",
        text: "[A audio attachment was omitted: the agent cannot read it.]",
      },
    ]);
  });

  it("passes string tool results through and converts multimodal ones", () => {
    expect(
      toToolOutput({ id: "t", role: "tool", toolCallId: "c", content: "done" }),
    ).toBe("done");
    expect(
      toToolOutput({
        id: "t",
        role: "tool",
        toolCallId: "c",
        content: [{ type: "text", text: "x" }],
      } as never),
    ).toEqual([{ type: "input_text", text: "x" }]);
  });

  it("builds a context part from context entries and non-empty state", () => {
    expect(contextPart([], {})).toBeUndefined();
    const part = contextPart([{ description: "Locale", value: "de-AT" }], {
      count: 1,
    });
    expect(part?.type).toBe("input_text");
    expect((part as { text: string }).text).toContain("- Locale: de-AT");
    expect((part as { text: string }).text).toContain('{"count":1}');
  });

  it("splits trailing user messages from earlier history on first contact", () => {
    const { history, pending } = splitFirstContact([
      { id: "u1", role: "user", content: "a" },
      { id: "a1", role: "assistant", content: "b" },
      { id: "u2", role: "user", content: "c" },
      { id: "u3", role: "user", content: "d" },
    ]);
    expect(history.map((message) => message.id)).toEqual(["u1", "a1"]);
    expect(pending.map((message) => message.id)).toEqual(["u2", "u3"]);
  });

  it("finds user messages that were not delivered yet", () => {
    expect(
      undeliveredUserMessages(
        [
          { id: "u1", role: "user", content: "a" },
          { id: "u2", role: "user", content: "b" },
        ],
        ["u1"],
      ).map((message) => message.id),
    ).toEqual(["u2"]);
  });
});

describe("tools", () => {
  it("lets backend tools shadow frontend tools and keeps built-in tools", () => {
    const merged = mergeTools(
      [
        { type: "web_search" },
        {
          type: "function",
          name: "lookup",
          description: "old",
          parameters: {},
        },
      ],
      [
        {
          name: "lookup",
          description: "backend",
          parameters: { type: "object", properties: {} },
          handler: () => "",
        },
      ],
      [
        { name: "lookup", description: "frontend", parameters: {} },
        { name: "ui", description: "", parameters: undefined },
      ],
    );
    expect(merged).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "lookup",
        description: "backend",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "ui",
        description: "ui",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("fingerprints tool lists independently of key order", () => {
    expect(
      fingerprintTools([
        {
          type: "function",
          name: "a",
          description: "d",
          parameters: { b: 1, a: 2 },
        },
      ]),
    ).toBe(
      fingerprintTools([
        {
          parameters: { a: 2, b: 1 },
          description: "d",
          name: "a",
          type: "function",
        } as never,
      ]),
    );
  });
});

describe("link citations", () => {
  it("extracts one citation per linked URL with the offset after the link", () => {
    const text =
      "Node 26 is current ([releases](https://nodejs.org/en/download)). See [releases](https://nodejs.org/en/download).";
    const citations = linkCitations(text);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      title: "releases",
      source: "https://nodejs.org/en/download",
      location: {
        type: "web",
        url: "https://nodejs.org/en/download",
        domain: "nodejs.org",
      },
    });
    expect(
      text
        .slice(0, citations[0].textOffset)
        .endsWith("(https://nodejs.org/en/download)"),
    ).toBe(true);
  });
});
