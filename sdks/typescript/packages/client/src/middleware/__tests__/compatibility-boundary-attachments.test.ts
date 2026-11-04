import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { of } from "rxjs";
import { AbstractAgent } from "@/agent";
import { EventType, type Message, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { upgradeMessageContent } from "../legacy-content";

const binary = { type: "binary", mimeType: "image/png", data: "image-data" };
const image = {
  type: "image",
  source: { type: "data", mimeType: "image/png", value: "image-data" },
  metadata: { filename: "image.png", caption: "Keep this metadata" },
};

function messageWithContent(content: unknown): Message {
  const message: Message = { id: "message", role: "user", content: "" };
  // Deliberately inject pre-1.0 wire content after constructing the typed message.
  // Parsing it first would reject precisely the legacy input under test.
  Object.assign(message, { content });
  return message;
}

class ValidatingAgent extends AbstractAgent {
  transportInput?: RunAgentInput;
  receivedInput?: RunAgentInput;

  constructor(private responseMessages?: Message[]) {
    super({});
  }

  run(input: RunAgentInput) {
    this.transportInput = input;
    this.receivedInput = RunAgentInputSchema.parse(input);
    const ids = { threadId: input.threadId, runId: input.runId };
    return of(
      { type: EventType.RUN_STARTED, ...ids },
      ...(this.responseMessages
        ? [{ type: EventType.MESSAGES_SNAPSHOT, messages: this.responseMessages }]
        : []),
      { type: EventType.RUN_FINISHED, ...ids },
    );
  }
}

async function send(content: unknown) {
  const agent = new ValidatingAgent();
  await agent.runAgent(
    {},
    {
      // Showcase adds its legacy mirror here, after preparing the run input.
      onRunInitialized: () => ({ messages: [messageWithContent(content)] }),
    },
  );
  return agent.receivedInput?.messages[0]?.content;
}

function upgrade(content: unknown) {
  return upgradeMessageContent(messageWithContent(content)).content;
}

beforeEach(() => {
  vi.stubEnv("SUPPRESS_TRANSFORMATION_WARNINGS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("always-on request attachment compatibility", () => {
  it("preserves the lifecycle input identity through transport validation", async () => {
    const agent = new ValidatingAgent();
    const messages = [messageWithContent([image, binary])];
    const originalMessages = structuredClone(messages);
    let initializedInput: RunAgentInput | undefined;

    await agent.runAgent(
      {},
      {
        onRunInitialized: ({ input }) => {
          initializedInput = input;
          return { messages };
        },
      },
    );

    expect(agent.transportInput).toBe(initializedInput);
    expect(agent.receivedInput?.messages[0]?.content).toEqual([image]);
    expect(messages).toEqual(originalMessages);
  });

  it("converts legacy input added at initialization before transport validation", async () => {
    await expect(send([binary])).resolves.toEqual([{ type: "image", source: image.source }]);
  });

  it.each([
    [image, binary],
    [binary, image],
  ])("keeps one modern attachment when a legacy mirror is present: %j", async (...content) => {
    await expect(send(content)).resolves.toEqual([image]);
  });

  it("passes modern input through with its metadata intact", async () => {
    await expect(send([image])).resolves.toEqual([image]);
  });

  it("still rejects malformed modern content", async () => {
    await expect(send([{ ...image, source: { ...image.source, value: 42 } }])).rejects.toThrow();
  });

  it("still converts and deduplicates inbound message snapshots", async () => {
    const agent = new ValidatingAgent([messageWithContent([image, binary])]);
    await agent.runAgent();
    expect(agent.messages[0]?.content).toEqual([image]);
  });
});

describe("shared legacy attachment conversion", () => {
  it.each([
    { mimeType: "image/png", type: "image" },
    { mimeType: "audio/mp3", type: "audio" },
    { mimeType: "video/mp4", type: "video" },
    { mimeType: "application/pdf", type: "document" },
  ])("converts $mimeType payloads and URLs", ({ mimeType, type }) => {
    for (const sourceType of ["data", "url"] as const) {
      const value = sourceType === "data" ? "payload" : "https://example.test/attachment";
      expect(upgrade([{ type: "binary", mimeType, [sourceType]: value }])).toEqual([
        { type, source: { type: sourceType, value, mimeType } },
      ]);
    }
  });

  it.each([{ content: "plain string" }, { content: [{ type: "text", text: "text part" }] }])(
    "preserves text content: $content",
    ({ content }) => {
      expect(upgrade(content)).toEqual(content);
    },
  );

  it("preserves non-user messages", () => {
    const messages: Message[] = [
      { id: "assistant", role: "assistant", content: "Hi" },
      { id: "system", role: "system", content: "You are helpful" },
    ];
    expect(messages.map(upgradeMessageContent)).toEqual(messages);
  });

  it("keeps mixed text, legacy media and unrelated modern media", () => {
    const text = { type: "text", text: "Look at this" };
    const remote = { type: "image", source: { type: "url", value: "https://example.test/image" } };
    expect(upgrade([text, binary, remote])).toEqual([
      text,
      { type: "image", source: image.source },
      remote,
    ]);
  });

  it("prefers data over URL and preserves the filename", () => {
    expect(
      upgrade([{ ...binary, url: "https://example.test/unused", filename: "photo.png" }]),
    ).toEqual([{ type: "image", source: image.source, metadata: { filename: "photo.png" } }]);
  });

  it("warns and preserves an id-only attachment that cannot be converted", () => {
    const legacy = { type: "binary", mimeType: "image/png", id: "asset-1" };
    expect(upgrade([legacy])).toEqual([legacy]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("asset-1"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("DEPRECATIONS.md"));
  });

  it("still rejects malformed legacy payloads before transport", async () => {
    await expect(send([{ ...binary, data: 42 }])).rejects.toThrow();
  });
});

describe("legacy attachment mirror matching", () => {
  it.each([
    [image, binary],
    [binary, image],
  ])("removes the legacy mirror independent of ordering: %j", (...content) => {
    expect(upgrade(content)).toEqual([image]);
  });

  it("preserves repeated modern attachments", () => {
    expect(upgrade([image, image, binary])).toEqual([image, image]);
  });

  it("preserves repeated legacy-only attachments", () => {
    expect(upgrade([binary, binary])).toEqual([
      { type: "image", source: image.source },
      { type: "image", source: image.source },
    ]);
  });

  it("retains a filename that the modern part does not contain", () => {
    const namedBinary = { ...binary, filename: "different.png" };
    expect(upgrade([image, namedBinary])).toEqual([
      image,
      { type: "image", source: image.source, metadata: { filename: "different.png" } },
    ]);
  });

  it("removes a mirror whose filename is already preserved", () => {
    expect(upgrade([image, { ...binary, filename: "image.png" }])).toEqual([image]);
  });

  it.each([
    { ...binary, data: "different-data" },
    { ...binary, mimeType: "image/jpeg" },
    { type: "binary", mimeType: "image/png", url: "image-data" },
  ])("keeps distinct legacy sources: %j", (legacy) => {
    expect(upgrade([image, legacy])).toHaveLength(2);
  });

  it("does not mutate the original content", () => {
    const content = [image, binary];
    const before = structuredClone(content);
    upgrade(content);
    expect(content).toEqual(before);
  });
});
