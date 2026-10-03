/**
 * Attachments in Strands' own durable history.
 *
 * With a session manager wired, Strands owns the thread's history and the
 * adapter's replay is off, so what the live turn hands the SDK is the only
 * copy a later process will see. These runs use a real `Agent`, a real
 * `SessionManager` over on-disk storage and a model, then read the snapshot
 * file itself, restart onto the same directory and take another turn.
 *
 * Audio is stored only when the configured model can take it. The provider
 * cases run the SDK's real `OpenAIModel` and `BedrockModel` with only their
 * transport replaced, so what they assert about the outgoing request is what
 * the SDK's own formatter built.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Agent as StrandsAgentCore,
  FileStorage,
  SessionManager,
  type Model,
} from "@strands-agents/sdk";
import {
  EventType,
  type BaseEvent,
  type InputContent,
  type Message as AguiMessage,
} from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig } from "../config";
import {
  AUDIO_DROP_FOR_UNSUPPORTED_MODEL,
  InstalledAudioBlock,
  bedrockConverseModel,
  errorCodes,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  openAIChatModel,
  persistedSnapshot,
  realStrandsAgent,
  snapshotPathOf,
  threadAgent,
} from "./helpers";

// The unified `Storage` interface ships from 1.10.0 onward, under its own
// subpath. On an older release the import fails and only the legacy
// `SnapshotStorage` form is exercised. The specifier is held in a variable so
// the bundler does not refuse to resolve it before the catch can run.
const STORAGE_SUBPATH = "@strands-agents/sdk/storage";
const unifiedStorage = (await import(/* @vite-ignore */ STORAGE_SUBPATH).catch(
  () => undefined,
)) as { LocalFileStorage: new (baseDir: string) => unknown } | undefined;

const SESSION_ID = "multimodal-thread";
const THREAD_ID = "multimodal-thread";

/** A WAV clip the size of the one that first showed the loss. */
function wavClip(total = 87_078): Buffer {
  const clip = Buffer.alloc(total);
  clip.write("RIFF", 0);
  clip.writeUInt32LE(total - 8, 4);
  clip.write("WAVEfmt ", 8);
  clip.writeUInt32LE(16, 16);
  clip.writeUInt16LE(1, 20);
  clip.writeUInt16LE(1, 22);
  clip.writeUInt32LE(16_000, 24);
  clip.writeUInt32LE(32_000, 28);
  clip.writeUInt16LE(2, 32);
  clip.writeUInt16LE(16, 34);
  clip.write("data", 36);
  clip.writeUInt32LE(total - 44, 40);
  for (let i = 44; i < total; i++) clip[i] = (i * 31 + 7) & 0xff;
  return clip;
}

const WAV = wavClip();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const AUDIO_ITEM = {
  type: "audio",
  source: {
    type: "data",
    mimeType: "audio/wav",
    value: WAV.toString("base64"),
  },
} as InputContent;

const firstTurn: AguiMessage = {
  id: "u1",
  role: "user",
  content: [
    { type: "text", text: "Transcribe this and describe the picture." },
    AUDIO_ITEM,
    {
      type: "image",
      source: {
        type: "data",
        mimeType: "image/png",
        value: PNG.toString("base64"),
      },
    },
  ] as InputContent[],
};

const audioOnlyTurn: AguiMessage = {
  id: "u1",
  role: "user",
  content: [AUDIO_ITEM],
};

type StoredBlock = {
  text?: string;
  audio?: { format: string; source: { bytes: string } };
  image?: { format: string; source: { bytes: string } };
};
type StoredMessage = { role: string; content: StoredBlock[] };

function storedMessages(dir: string): StoredMessage[] {
  return persistedSnapshot(dir).data.messages as StoredMessage[];
}

/** Each stored message as its role and the kind of every block it holds. */
function storedShape(dir: string): Array<[string, string[]]> {
  return storedMessages(dir).map((m) => [
    m.role,
    m.content.map((b) => Object.keys(b)[0]!),
  ]);
}

function mediaDropped(events: BaseEvent[]): unknown[] {
  return events
    .filter(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as { name?: string }).name === "MediaDropped",
    )
    .map((e) => (e as unknown as { value: unknown }).value);
}

function storedBlocks(dir: string, kind: "audio" | "image") {
  return storedMessages(dir).flatMap((m) =>
    m.content.flatMap((b) => (b[kind] ? [b[kind]!] : [])),
  );
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const storageKinds = [
  {
    name: "unified storage",
    available: unifiedStorage !== undefined,
    make: (dir: string) => new unifiedStorage!.LocalFileStorage(dir),
  },
  {
    name: "legacy snapshot storage",
    available: true,
    make: (dir: string) => ({ snapshot: new FileStorage(dir) }),
  },
];

describe.runIf(InstalledAudioBlock !== undefined)(
  "attachments in the native session history for a model that takes audio",
  () => {
    for (const kind of storageKinds) {
      describe.runIf(kind.available)(kind.name, () => {
        /** A fresh adapter, agent and session manager over `dir`. */
        function bootProcess(dir: string, reply: string) {
          return realStrandsAgent([modelTurn.text(reply)], {
            config: {
              // The scripted model takes any block, and the adapter cannot
              // know that about a custom model, so it is declared.
              audioInputSupported: true,
              sessionManagerProvider: () =>
                new SessionManager({
                  sessionId: SESSION_ID,
                  storage: kind.make(dir) as never,
                }),
            },
          });
        }

        async function run(
          agent: ReturnType<typeof bootProcess>["agent"],
          messages: AguiMessage[],
        ) {
          const events = [];
          for await (const e of agent.run(
            minimalRunInput({ threadId: THREAD_ID, messages }),
          )) {
            events.push(e);
          }
          expectCompletedRun(events);
          return events;
        }

        it("stores the audio clip byte for byte beside the image", async () => {
          const dir = mkdtempSync(join(tmpdir(), "agui-strands-media-"));
          dirs.push(dir);
          const events = await run(bootProcess(dir, "heard it").agent, [
            firstTurn,
          ]);

          expect(
            events.filter(
              (e) => (e as { name?: string }).name === "MediaDropped",
            ),
          ).toEqual([]);
          const [audio, ...extraAudio] = storedBlocks(dir, "audio");
          expect(extraAudio).toEqual([]);
          expect(audio!.format).toBe("wav");
          const onDisk = Buffer.from(audio!.source.bytes, "base64");
          expect(onDisk.length).toBe(WAV.length);
          expect(sha256(onDisk)).toBe(sha256(WAV));
          const [image] = storedBlocks(dir, "image");
          expect(sha256(Buffer.from(image!.source.bytes, "base64"))).toBe(
            sha256(PNG),
          );
        });

        it("restores the clip after a restart and keeps one copy through another turn", async () => {
          const dir = mkdtempSync(join(tmpdir(), "agui-strands-media-"));
          dirs.push(dir);
          await run(bootProcess(dir, "heard it").agent, [firstTurn]);

          const restarted = bootProcess(dir, "still here");
          await run(restarted.agent, [
            firstTurn,
            { id: "a1", role: "assistant", content: "heard it" },
            { id: "u2", role: "user", content: "Say it again." },
          ]);

          expect(
            storedMessages(dir).map((m) => [
              m.role,
              m.content.map((b) => Object.keys(b)[0]),
            ]),
          ).toEqual([
            ["user", ["text", "audio", "image"]],
            ["assistant", ["text"]],
            ["user", ["text"]],
            ["assistant", ["text"]],
          ]);
          const [audio] = storedBlocks(dir, "audio");
          expect(sha256(Buffer.from(audio!.source.bytes, "base64"))).toBe(
            sha256(WAV),
          );

          // The restarted agent read the clip back as a real block, not as
          // the serialized form on disk.
          const restored = threadAgent(restarted.agent, THREAD_ID)!.messages[0]!
            .content[1];
          expect(restored).toBeInstanceOf(InstalledAudioBlock!);
          expect(
            sha256(
              (restored as { source: { bytes: Uint8Array } }).source.bytes,
            ),
          ).toBe(sha256(WAV));
        });
      });
    }
  },
);

describe("audio and the configured model", () => {
  for (const kind of storageKinds) {
    describe.runIf(kind.available)(kind.name, () => {
      function freshDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "agui-strands-audio-"));
        dirs.push(dir);
        return dir;
      }

      /** A fresh adapter over `model`, persisting into `dir`. */
      function adapterOver(
        model: Model,
        dir: string,
        config: StrandsAgentConfig = {},
      ): StrandsAgent {
        return new StrandsAgent({
          agent: new StrandsAgentCore({ model }),
          name: "audio-capability",
          config: {
            ...config,
            sessionManagerProvider: () =>
              new SessionManager({
                sessionId: SESSION_ID,
                storage: kind.make(dir) as never,
              }),
          },
        });
      }

      async function run(
        agent: StrandsAgent,
        messages: AguiMessage[],
      ): Promise<BaseEvent[]> {
        const events: BaseEvent[] = [];
        for await (const e of agent.run(
          minimalRunInput({ threadId: THREAD_ID, messages }),
        )) {
          events.push(e);
        }
        return events;
      }

      describe("on OpenAI, whose formatter skips audio", () => {
        it("reports the clip, completes the text turn and stores no audio", async () => {
          const dir = freshDir();
          const openai = openAIChatModel("I see a pixel.");
          const events = await run(adapterOver(openai.model, dir), [firstTurn]);

          expectCompletedRun(events);
          expect(mediaDropped(events)).toEqual([
            {
              dropped: [
                { type: "audio", reason: AUDIO_DROP_FOR_UNSUPPORTED_MODEL },
              ],
              delivered: 1,
            },
          ]);
          // The provider was asked about the text and the picture, and the
          // SDK had no audio block to skip.
          expect(openai.requests).toHaveLength(1);
          const [user] = openai.requests[0]!.messages as Array<{
            role: string;
            content: Array<{ type: string }>;
          }>;
          expect(user!.content.map((part) => part.type)).toEqual([
            "text",
            "image_url",
          ]);
          expect(storedShape(dir)).toEqual([
            ["user", ["text", "image"]],
            ["assistant", ["text"]],
          ]);
          expect(storedBlocks(dir, "audio")).toEqual([]);
        });

        it("serves a text-only follow-up from a fresh adapter over the saved session", async () => {
          const dir = freshDir();
          await run(adapterOver(openAIChatModel("I see a pixel.").model, dir), [
            firstTurn,
          ]);

          const restarted = openAIChatModel("Still a pixel.");
          const events = await run(adapterOver(restarted.model, dir), [
            firstTurn,
            { id: "a1", role: "assistant", content: "I see a pixel." },
            { id: "u2", role: "user", content: "Say it again." },
          ]);

          expectCompletedRun(events);
          expect(mediaDropped(events)).toEqual([]);
          expect(
            (restarted.requests[0]!.messages as Array<{ role: string }>).map(
              (m) => m.role,
            ),
          ).toEqual(["user", "assistant", "user"]);
          expect(storedShape(dir)).toEqual([
            ["user", ["text", "image"]],
            ["assistant", ["text"]],
            ["user", ["text"]],
            ["assistant", ["text"]],
          ]);
          expect(storedBlocks(dir, "audio")).toEqual([]);
        });

        it("refuses an audio-only turn with a clear error and stores no turn for it", async () => {
          const dir = freshDir();
          const openai = openAIChatModel("unused");
          const events = await run(adapterOver(openai.model, dir), [
            audioOnlyTurn,
          ]);

          expect(mediaDropped(events)).toEqual([
            {
              dropped: [
                { type: "audio", reason: AUDIO_DROP_FOR_UNSUPPORTED_MODEL },
              ],
              delivered: 0,
            },
          ]);
          expect(errorCodes(events)).toEqual(["MEDIA_RESOLUTION_FAILED"]);
          // Refused before the model: the provider was never sent a user
          // message with nothing in it.
          expect(openai.requests).toEqual([]);
          // Nor was the turn saved: the session has no snapshot at all yet.
          expect(snapshotPathOf(dir)).toBeUndefined();

          // Nothing unusable was left behind for the next turn to trip on.
          const next = openAIChatModel("Hello.");
          const followUp = await run(adapterOver(next.model, dir), [
            audioOnlyTurn,
            { id: "u2", role: "user", content: "Hello?" },
          ]);
          expectCompletedRun(followUp);
          expect(storedShape(dir)).toEqual([
            ["user", ["text"]],
            ["assistant", ["text"]],
          ]);
        });
      });

      describe("on Bedrock, whose formatter sends audio", () => {
        it.runIf(InstalledAudioBlock !== undefined)(
          "sends and stores the clip byte for byte when left to auto-detect",
          async () => {
            const dir = freshDir();
            const bedrock = bedrockConverseModel("heard it");
            const events = await run(adapterOver(bedrock.model, dir), [
              firstTurn,
            ]);

            expectCompletedRun(events);
            expect(mediaDropped(events)).toEqual([]);
            const sent = bedrock.requests[0]!.messages[0]!.content as Array<{
              audio?: { format: string; source: { bytes: Uint8Array } };
            }>;
            const audio = sent.find((b) => b.audio)?.audio;
            expect(audio?.format).toBe("wav");
            expect(sha256(audio!.source.bytes)).toBe(sha256(WAV));
            const [stored] = storedBlocks(dir, "audio");
            expect(sha256(Buffer.from(stored!.source.bytes, "base64"))).toBe(
              sha256(WAV),
            );
          },
        );

        it("drops the clip when configured as unable to take audio", async () => {
          const dir = freshDir();
          const bedrock = bedrockConverseModel("I see a pixel.");
          const events = await run(
            adapterOver(bedrock.model, dir, { audioInputSupported: false }),
            [firstTurn],
          );

          expectCompletedRun(events);
          expect(mediaDropped(events)).toEqual([
            {
              dropped: [
                { type: "audio", reason: AUDIO_DROP_FOR_UNSUPPORTED_MODEL },
              ],
              delivered: 1,
            },
          ]);
          expect(
            bedrock.requests[0]!.messages[0]!.content.map(
              (b) => Object.keys(b as object)[0],
            ),
          ).toEqual(["text", "image"]);
          expect(storedBlocks(dir, "audio")).toEqual([]);
        });
      });

      it("treats a custom model as unable to take audio unless configured", async () => {
        const dir = freshDir();
        const { agent } = realStrandsAgent([modelTurn.text("ok")], {
          config: {
            sessionManagerProvider: () =>
              new SessionManager({
                sessionId: SESSION_ID,
                storage: kind.make(dir) as never,
              }),
          },
        });
        const events = await run(agent, [firstTurn]);

        expectCompletedRun(events);
        expect(mediaDropped(events)).toEqual([
          {
            dropped: [
              { type: "audio", reason: AUDIO_DROP_FOR_UNSUPPORTED_MODEL },
            ],
            delivered: 1,
          },
        ]);
        expect(storedBlocks(dir, "audio")).toEqual([]);
      });
    });
  }
});
