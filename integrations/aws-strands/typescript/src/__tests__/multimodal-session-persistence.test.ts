/**
 * Attachments in Strands' own durable history.
 *
 * With a session manager wired, Strands owns the thread's history and the
 * adapter's replay is off, so what the live turn hands the SDK is the only
 * copy a later process will see. These runs use a real `Agent`, a real
 * `SessionManager` over on-disk storage and a scripted model, then read the
 * snapshot file itself, restart onto the same directory and take another turn.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorage, SessionManager } from "@strands-agents/sdk";
import type { InputContent, Message as AguiMessage } from "@ag-ui/core";

import {
  InstalledAudioBlock,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  persistedSnapshot,
  realStrandsAgent,
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

const firstTurn: AguiMessage = {
  id: "u1",
  role: "user",
  content: [
    { type: "text", text: "Transcribe this and describe the picture." },
    {
      type: "audio",
      source: {
        type: "data",
        mimeType: "audio/wav",
        value: WAV.toString("base64"),
      },
    },
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

type StoredBlock = {
  text?: string;
  audio?: { format: string; source: { bytes: string } };
  image?: { format: string; source: { bytes: string } };
};
type StoredMessage = { role: string; content: StoredBlock[] };

function storedMessages(dir: string): StoredMessage[] {
  return persistedSnapshot(dir).data.messages as StoredMessage[];
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
  "attachments in the native session history",
  () => {
    for (const kind of storageKinds) {
      describe.runIf(kind.available)(kind.name, () => {
        /** A fresh adapter, agent and session manager over `dir`. */
        function bootProcess(dir: string, reply: string) {
          return realStrandsAgent([modelTurn.text(reply)], {
            config: {
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
