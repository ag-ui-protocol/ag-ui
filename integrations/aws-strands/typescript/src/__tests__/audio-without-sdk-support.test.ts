/**
 * Audio on an SDK that predates `AudioBlock`.
 *
 * The peer range admits `@strands-agents/sdk` releases before 1.14.0, which
 * export no audio block. The SDK module is replaced here by the real one with
 * `AudioBlock` removed, so this file asserts that side of the line whatever
 * release is installed: the clip is reported with a reason naming the fix,
 * nothing is fetched for it, and the rest of the message still converts.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventType, type BaseEvent, type InputContent } from "@ag-ui/core";

vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();
  // Present but undefined, which is what a namespace read of a missing export
  // gives on a real older release. Omitting the key makes vitest throw instead.
  return { ...actual, AudioBlock: undefined };
});

import {
  convertAguiContentToStrandsDetailed,
  urlFetchTransport,
} from "../utils";
import {
  AUDIO_UNSUPPORTED_BY_SDK,
  InstalledAudioBlock,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";

const quietLog = { debug: () => {}, warn: () => {}, error: () => {} };

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("audio on an SDK without an audio block", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sees no AudioBlock export", () => {
    expect(InstalledAudioBlock).toBeUndefined();
  });

  it("reports the clip with the SDK requirement and keeps the rest", async () => {
    const { blocks, dropped } = await convertAguiContentToStrandsDetailed(
      [
        { type: "text", text: "listen and look" },
        {
          type: "audio",
          source: { type: "data", mimeType: "audio/wav", value: "UklGRg==" },
        },
        {
          type: "image",
          source: { type: "data", mimeType: "image/png", value: PNG },
        },
      ] as InputContent[],
      quietLog,
    );
    expect(blocks.map((b) => (b as { type: string }).type)).toEqual([
      "textBlock",
      "imageBlock",
    ]);
    expect(dropped).toEqual([
      { type: "audio", reason: AUDIO_UNSUPPORTED_BY_SDK },
    ]);
  });

  it("does not fetch a url clip it cannot deliver", async () => {
    const fetchMock = vi.spyOn(urlFetchTransport, "request");
    const { dropped } = await convertAguiContentToStrandsDetailed(
      [
        {
          type: "audio",
          source: {
            type: "url",
            mimeType: "audio/wav",
            value: "https://example.test/clip.wav",
          },
        },
      ] as InputContent[],
      quietLog,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dropped).toEqual([
      { type: "audio", reason: AUDIO_UNSUPPORTED_BY_SDK },
    ]);
  });

  it("tells the client which clip did not reach the model, and why", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("ok")]);
    const events: BaseEvent[] = [];
    for await (const e of agent.run(
      minimalRunInput({
        messages: [
          {
            id: "u1",
            role: "user",
            content: [
              { type: "text", text: "listen" },
              {
                type: "audio",
                source: {
                  type: "data",
                  mimeType: "audio/wav",
                  value: "UklGRg==",
                },
              },
            ],
          } as never,
        ],
      }),
    )) {
      events.push(e);
    }
    expectCompletedRun(events);
    const reported = events.filter(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as { name?: string }).name === "MediaDropped",
    );
    expect(reported).toHaveLength(1);
    expect((reported[0] as unknown as { value: unknown }).value).toEqual({
      dropped: [{ type: "audio", reason: AUDIO_UNSUPPORTED_BY_SDK }],
      delivered: 0,
    });
  });
});
