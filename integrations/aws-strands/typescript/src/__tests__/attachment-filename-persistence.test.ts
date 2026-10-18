/**
 * Original attachment filenames survive native Strands persistence.
 *
 * A client names each attachment in the part's `metadata` (CopilotKit writes
 * `metadata.filename`). The model never sees that name: a document's Bedrock
 * `name` stays the neutral hashed value. The name has to stay recoverable from
 * the native store anyway, tied to the block holding its bytes. The adapter
 * records it on the native user message under `metadata.custom["ag-ui"]`, one
 * entry per named block: the block's position in that message's content, the
 * block's kind, and the filename.
 *
 * These run a real `Agent` over a real `SessionManager` writing to a temp dir.
 * Only the model is scripted, and what it receives is bound through the SDK's
 * Bedrock formatter to show the provider request stays name-free.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  Agent as StrandsAgentCore,
  BedrockModel,
  FileStorage,
  SessionManager,
  type Message as StrandsMessage,
} from "@strands-agents/sdk";
import type { InputContent, Message, RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";
import { convertAguiContentToStrandsDetailed } from "../utils";
import {
  AUDIO_DROP_FOR_UNSUPPORTED_MODEL,
  InstalledAudioBlock,
  bedrockConverseModel,
  collect,
  expectNoRunError,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  snapshotPathOf,
  threadAgent,
  type ScriptedModel,
} from "./helpers";

const SESSION_ID = "attachments-session";

const PNG = Buffer.from("\x89PNG\r\n\x1a\n-holiday", "latin1");
const PDF = Buffer.from("%PDF-1.7 quarterly");
const MP4 = Buffer.from("\x00\x00\x00\x18ftypmp42-clip", "latin1");

const IMAGE_NAME = "holiday photo.png";
const DOCUMENT_NAME = "Q3 report (final).pdf";
const VIDEO_NAME = "clip.mp4";
const ALL_NAMES = [IMAGE_NAME, DOCUMENT_NAME, VIDEO_NAME];

const EXPECTED_NAMED = [
  { filename: IMAGE_NAME, type: "image", format: "png", bytes: PNG },
  { filename: DOCUMENT_NAME, type: "document", format: "pdf", bytes: PDF },
  { filename: VIDEO_NAME, type: "video", format: "mp4", bytes: MP4 },
];

const dirs: string[] = [];

function storageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agui-strands-attachments-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function data(bytes: Buffer, mimeType: string) {
  return { type: "data", value: bytes.toString("base64"), mimeType } as const;
}

function attachmentsMessage(): Message {
  return {
    id: "u1",
    role: "user",
    content: [
      { type: "text", text: "what are these?" },
      {
        type: "image",
        source: data(PNG, "image/png"),
        metadata: { filename: IMAGE_NAME },
      },
      {
        type: "document",
        source: data(PDF, "application/pdf"),
        metadata: { filename: DOCUMENT_NAME },
      },
      {
        type: "video",
        source: data(MP4, "video/mp4"),
        metadata: { fileName: VIDEO_NAME },
      },
    ] as InputContent[],
  } as Message;
}

type Storage = () => ConstructorParameters<typeof SessionManager>[0]["storage"];

const legacyStorage =
  (dir: string): Storage =>
  () => ({ snapshot: new FileStorage(dir) });

/**
 * The unified `Storage` backend newer SDKs ship, or undefined where the
 * installed SDK predates it. The specifier is held in a variable so this file
 * still typechecks against an SDK without the subpath.
 */
async function unifiedStorage(): Promise<
  ((dir: string) => Storage) | undefined
> {
  const specifier = "@strands-agents/sdk/storage";
  try {
    const mod = (await import(specifier)) as {
      LocalFileStorage?: new (dir: string) => unknown;
    };
    const LocalFileStorage = mod.LocalFileStorage;
    if (!LocalFileStorage) return undefined;
    return (dir) => () => new LocalFileStorage(dir) as never;
  } catch {
    return undefined;
  }
}

const UNIFIED = await unifiedStorage();

const STORAGES: Array<[string, ((dir: string) => Storage) | undefined]> = [
  ["legacy snapshot FileStorage", legacyStorage],
  ["unified LocalFileStorage", UNIFIED],
];

function persistedAdapter(
  storage: Storage,
  turns = [modelTurn.text("done")],
  config: StrandsAgentConfig = {},
) {
  return realStrandsAgent(turns, {
    config: {
      ...config,
      sessionManagerProvider: () =>
        new SessionManager({ sessionId: SESSION_ID, storage: storage() }),
    },
  });
}

function input(runId: string, messages: Message[]): RunAgentInput {
  return minimalRunInput({ threadId: "thread-1", runId, messages });
}

/** The messages `snapshot_latest.json` holds on disk, as written. */
function onDisk(dir: string): Array<Record<string, unknown>> {
  const path = snapshotPathOf(dir);
  expect(path, `no snapshot was persisted under ${dir}`).toBeDefined();
  return JSON.parse(readFileSync(path!, "utf8")).data.messages;
}

function kindOf(block: Record<string, unknown>): string {
  const keys = Object.keys(block);
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

/** Every named block of a serialized message, read through its metadata. */
function namedBlocks(message: Record<string, unknown>) {
  const entries =
    (
      message.metadata as
        | {
            custom?: {
              "ag-ui"?: {
                attachments?: {
                  index: number;
                  type: string;
                  filename: string;
                }[];
              };
            };
          }
        | undefined
    )?.custom?.["ag-ui"]?.attachments ?? [];
  const content = message.content as Record<string, unknown>[];
  return entries.map((entry) => {
    const block = content[entry.index]!;
    const type = kindOf(block);
    expect(type).toBe(entry.type);
    const media = block[type] as {
      format: string;
      source: { bytes: string };
    };
    return {
      filename: entry.filename,
      type,
      format: media.format,
      bytes: Buffer.from(media.source.bytes, "base64"),
    };
  });
}

function mediaBlocks(messages: Array<Record<string, unknown>>) {
  return messages.flatMap((message) =>
    (message.content as Record<string, unknown>[]).filter((block) =>
      ["image", "document", "video", "audio"].includes(kindOf(block)),
    ),
  );
}

/** What the Bedrock Converse formatter would send; no AWS call is made. */
function bedrockRequest(messages: StrandsMessage[]) {
  const bedrock = new BedrockModel({
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    clientConfig: { region: "us-east-1" },
  });
  return (
    bedrock as unknown as {
      _formatRequest(
        messages: StrandsMessage[],
        options: object,
      ): { messages: Array<{ role: string; content: unknown[] }> };
    }
  )._formatRequest(messages, {});
}

function expectNameFreeProviderRequest(seen: StrandsMessage[]): void {
  const request = bedrockRequest(seen);
  const wire = JSON.stringify(request.messages, (_key, value) =>
    value instanceof Uint8Array ? `<${value.length} bytes>` : value,
  );
  for (const name of ALL_NAMES) expect(wire).not.toContain(name);
  expect(wire).not.toContain('"metadata"');
  const documents = request.messages.flatMap((message) =>
    message.content.flatMap((block) => {
      const document = (block as { document?: { name: string } }).document;
      return document ? [document] : [];
    }),
  );
  expect(documents).toHaveLength(1);
  expect(documents[0]!.name).toMatch(/^document-[0-9a-f]{32}$/);
}

function lastTurn(model: ScriptedModel): StrandsMessage[] {
  return model.seenMessages[model.seenMessages.length - 1]!;
}

describe.each(STORAGES)("attachment filenames in %s", (_label, storageFor) => {
  it.skipIf(!storageFor)(
    "are recoverable from the store, beside their bytes and format",
    async () => {
      const dir = storageDir();
      const { agent, model } = persistedAdapter(storageFor!(dir));

      expectNoRunError(
        await collect(agent, input("run-1", [attachmentsMessage()])),
        "first run",
      );

      const messages = onDisk(dir);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(namedBlocks(messages[0]!)).toEqual(EXPECTED_NAMED);
      const [document] = (
        messages[0]!.content as Array<{ document?: { name: string } }>
      ).flatMap((block) => (block.document ? [block.document] : []));
      expect(document!.name).toMatch(/^document-/);
      expect(document!.name).not.toContain(DOCUMENT_NAME);

      expect(model.seenMessages).toHaveLength(1);
      expectNameFreeProviderRequest(lastTurn(model));
    },
  );

  it.skipIf(!storageFor)(
    "keep one named record through a later turn in a new process",
    async () => {
      const dir = storageDir();
      const first = attachmentsMessage();
      const { agent } = persistedAdapter(storageFor!(dir));
      expectNoRunError(
        await collect(agent, input("run-1", [first])),
        "first run",
      );

      // A new process, and a client that resends the whole thread.
      const restarted = persistedAdapter(storageFor!(dir));
      expectNoRunError(
        await collect(
          restarted.agent,
          input("run-2", [
            first,
            { id: "a1", role: "assistant", content: "done" } as Message,
            {
              id: "u2",
              role: "user",
              content: "and which one is newest?",
            } as Message,
          ]),
        ),
        "second run",
      );

      const messages = onDisk(dir);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(messages.map(namedBlocks)).toEqual([EXPECTED_NAMED, [], [], []]);
      expect(mediaBlocks(messages)).toHaveLength(3);

      expect(restarted.model.seenMessages).toHaveLength(1);
      expect(lastTurn(restarted.model)).toHaveLength(3);
      expectNameFreeProviderRequest(lastTurn(restarted.model));
    },
  );
});

describe("attachment filenames on the non-persisted paths", () => {
  it("are recorded once when the request's history is replayed", async () => {
    const { agent, model } = realStrandsAgent([
      modelTurn.text("done"),
      modelTurn.text("done"),
    ]);
    const first = attachmentsMessage();
    expectNoRunError(
      await collect(agent, input("run-1", [first])),
      "first run",
    );
    expectNoRunError(
      await collect(
        agent,
        input("run-2", [
          first,
          { id: "a1", role: "assistant", content: "done" } as Message,
          { id: "u2", role: "user", content: "and now?" } as Message,
        ]),
      ),
      "second run",
    );

    const history = threadAgent(agent)!.messages.map(
      (message) => message.toJSON() as unknown as Record<string, unknown>,
    );
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history.map(namedBlocks)).toEqual([EXPECTED_NAMED, [], [], []]);
    expectNameFreeProviderRequest(lastTurn(model));
  });

  it("are recorded on the seed a cold thread starts from", async () => {
    // With replay off the seed is the history, so nothing rebuilds it.
    const { agent } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });
    expectNoRunError(
      await collect(
        agent,
        input("run-1", [
          attachmentsMessage(),
          { id: "a1", role: "assistant", content: "done" } as Message,
          { id: "u2", role: "user", content: "and now?" } as Message,
        ]),
      ),
      "seeded run",
    );

    const history = threadAgent(agent)!.messages.map(
      (message) => message.toJSON() as unknown as Record<string, unknown>,
    );
    expect(history.map(namedBlocks)).toEqual([EXPECTED_NAMED, [], [], []]);
  });
});

describe("attachment filename bookkeeping", () => {
  it("indexes a lone named document past the blank text block", async () => {
    const dir = storageDir();
    const { agent } = persistedAdapter(legacyStorage(dir));
    expectNoRunError(
      await collect(
        agent,
        input("run-1", [
          {
            id: "u1",
            role: "user",
            content: [
              {
                type: "document",
                source: data(PDF, "application/pdf"),
                metadata: { filename: DOCUMENT_NAME },
              },
            ] as InputContent[],
          } as Message,
        ]),
      ),
      "first run",
    );

    const [user] = onDisk(dir);
    // Bedrock needs a text block beside a document, so one is put first.
    expect((user!.content as unknown[])[0]).toEqual({ text: " " });
    expect(namedBlocks(user!)).toEqual([
      { filename: DOCUMENT_NAME, type: "document", format: "pdf", bytes: PDF },
    ]);
  });

  it("does not move a later name onto a block when one is dropped", async () => {
    const { blocks, filenames } = await convertAguiContentToStrandsDetailed([
      {
        type: "image",
        source: data(Buffer.from("BM-bitmap"), "image/bmp"),
        metadata: { filename: "dropped.bmp" },
      },
      {
        type: "image",
        source: data(PNG, "image/png"),
        metadata: { filename: IMAGE_NAME },
      },
      {
        type: "binary",
        mimeType: "image/jpeg",
        data: Buffer.from("\xff\xd8jpeg", "latin1").toString("base64"),
        filename: "legacy.jpg",
      },
    ] as InputContent[]);

    expect(blocks).toHaveLength(2);
    expect(filenames.map(({ block, filename }) => [block, filename])).toEqual([
      [blocks[0], IMAGE_NAME],
      [blocks[1], "legacy.jpg"],
    ]);
  });

  it("records nothing for an unnamed or blank name", async () => {
    const { filenames } = await convertAguiContentToStrandsDetailed([
      { type: "image", source: data(PNG, "image/png") },
      {
        type: "image",
        source: data(PNG, "image/png"),
        metadata: { filename: "   ", fileName: 7 },
      },
    ] as InputContent[]);
    expect(filenames).toEqual([]);
  });
});

const AUDIO_NAME = "voice memo.wav";
const WAV = Buffer.concat([
  Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"),
  Buffer.alloc(32, 7),
]);

function audioMessage(): Message {
  return {
    id: "u1",
    role: "user",
    content: [
      { type: "text", text: "what is in this recording?" },
      {
        type: "image",
        source: data(PNG, "image/png"),
        metadata: { filename: IMAGE_NAME },
      },
      {
        type: "audio",
        source: data(WAV, "audio/wav"),
        metadata: { filename: AUDIO_NAME },
      },
      {
        type: "video",
        source: data(MP4, "video/mp4"),
        metadata: { fileName: VIDEO_NAME },
      },
    ] as InputContent[],
  } as Message;
}

const EXPECTED_WITH_AUDIO = [
  { filename: IMAGE_NAME, type: "image", format: "png", bytes: PNG },
  { filename: AUDIO_NAME, type: "audio", format: "wav", bytes: WAV },
  { filename: VIDEO_NAME, type: "video", format: "mp4", bytes: MP4 },
];

function attachmentIndexes(message: Record<string, unknown>): number[] {
  const metadata = message.metadata as {
    custom: { "ag-ui": { attachments: { index: number }[] } };
  };
  return metadata.custom["ag-ui"].attachments.map((entry) => entry.index);
}

/** A process whose model takes audio, and the provider messages it was sent. */
type AudioProcess = (storage: Storage) => {
  agent: StrandsAgent;
  sent: () => unknown[];
};

const AUDIO_MODELS: Array<[string, AudioProcess]> = [
  [
    "Bedrock configured to take audio",
    (storage) => {
      const bedrock = bedrockConverseModel("done");
      const agent = new StrandsAgent({
        agent: new StrandsAgentCore({ model: bedrock.model }),
        name: "attachments",
        config: {
          audioInputSupported: true,
          sessionManagerProvider: () =>
            new SessionManager({ sessionId: SESSION_ID, storage: storage() }),
        },
      });
      return {
        agent,
        sent: () => bedrock.requests[bedrock.requests.length - 1]!.messages,
      };
    },
  ],
  [
    "a custom model declared audio-capable",
    (storage) => {
      const { agent, model } = persistedAdapter(
        storage,
        [modelTurn.text("done")],
        { audioInputSupported: true },
      );
      return { agent, sent: () => bedrockRequest(lastTurn(model)).messages };
    },
  ],
];

describe.each(STORAGES)(
  "audio attachment filenames in %s",
  (_label, storageFor) => {
    describe.each(AUDIO_MODELS)("for %s", (_model, boot) => {
      it.skipIf(!storageFor || InstalledAudioBlock === undefined)(
        "keep the delivered clip's name through a restart and another turn",
        async () => {
          const dir = storageDir();
          const first = audioMessage();
          expectNoRunError(
            await collect(
              boot(storageFor!(dir)).agent,
              input("run-1", [first]),
            ),
            "first run",
          );

          const [user] = onDisk(dir);
          expect(namedBlocks(user!)).toEqual(EXPECTED_WITH_AUDIO);
          expect(attachmentIndexes(user!)).toEqual([1, 2, 3]);

          // A new process, and a client that resends the whole thread.
          const restarted = boot(storageFor!(dir));
          expectNoRunError(
            await collect(
              restarted.agent,
              input("run-2", [
                first,
                { id: "a1", role: "assistant", content: "done" } as Message,
                {
                  id: "u2",
                  role: "user",
                  content: "and how long is it?",
                } as Message,
              ]),
            ),
            "second run",
          );

          const messages = onDisk(dir);
          expect(messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
          ]);
          expect(messages.map(namedBlocks)).toEqual([
            EXPECTED_WITH_AUDIO,
            [],
            [],
            [],
          ]);
          expect(
            mediaBlocks(messages).filter((block) => kindOf(block) === "audio"),
          ).toHaveLength(1);

          const wire = JSON.stringify(restarted.sent(), (_key, value) =>
            value instanceof Uint8Array ? `<${value.length} bytes>` : value,
          );
          expect(wire).toContain('"audio"');
          for (const name of [IMAGE_NAME, AUDIO_NAME, VIDEO_NAME])
            expect(wire).not.toContain(name);
        },
      );
    });

    it.skipIf(!storageFor)(
      "record no name for a refused clip and keep the others' indexes",
      async () => {
        const dir = storageDir();
        const { agent } = persistedAdapter(storageFor!(dir));
        const events = await collect(agent, input("run-1", [audioMessage()]));
        expectNoRunError(events, "first run");
        const dropped = events.flatMap((event) =>
          (event as { name?: string }).name === "MediaDropped"
            ? [(event as unknown as { value: unknown }).value]
            : [],
        );
        expect(dropped).toEqual([
          {
            dropped: [
              { type: "audio", reason: AUDIO_DROP_FOR_UNSUPPORTED_MODEL },
            ],
            delivered: 2,
          },
        ]);

        const [user] = onDisk(dir);
        expect(
          (user!.content as Record<string, unknown>[]).map(kindOf),
        ).toEqual(["text", "image", "video"]);
        expect(namedBlocks(user!)).toEqual([
          { filename: IMAGE_NAME, type: "image", format: "png", bytes: PNG },
          { filename: VIDEO_NAME, type: "video", format: "mp4", bytes: MP4 },
        ]);
        expect(attachmentIndexes(user!)).toEqual([1, 2]);
        expect(JSON.stringify(user)).not.toContain(AUDIO_NAME);
      },
    );
  },
);

describe("audio attachment filename bookkeeping", () => {
  const parts = [
    {
      type: "audio",
      source: data(WAV, "audio/wav"),
      metadata: { filename: AUDIO_NAME },
    },
    {
      type: "image",
      source: data(PNG, "image/png"),
      metadata: { filename: IMAGE_NAME },
    },
  ] as InputContent[];

  it.skipIf(InstalledAudioBlock === undefined)(
    "names a converted clip",
    async () => {
      const { blocks, filenames } = await convertAguiContentToStrandsDetailed(
        parts,
        undefined,
        { audioInputSupported: true },
      );
      expect(blocks).toHaveLength(2);
      expect(filenames.map(({ block, filename }) => [block, filename])).toEqual(
        [
          [blocks[0], AUDIO_NAME],
          [blocks[1], IMAGE_NAME],
        ],
      );
    },
  );

  it("names nothing for a refused clip", async () => {
    const { blocks, filenames, dropped } =
      await convertAguiContentToStrandsDetailed(parts, undefined, {
        audioInputSupported: false,
      });
    expect(dropped.map((entry) => entry.type)).toEqual(["audio"]);
    expect(filenames.map(({ block, filename }) => [block, filename])).toEqual([
      [blocks[0], IMAGE_NAME],
    ]);
  });
});
