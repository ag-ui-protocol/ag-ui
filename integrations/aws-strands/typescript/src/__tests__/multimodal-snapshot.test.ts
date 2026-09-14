import { describe, expect, it } from "vitest";
import { EventType, type InputContent, type UserMessage } from "@ag-ui/core";
import { buildSnapshotMessages } from "../agent";
import {
  collect,
  minimalRunInput,
  scriptedStrandsAgent,
  stream,
} from "./helpers";

const attachments: InputContent[] = [
  {
    type: "image",
    source: { type: "data", mimeType: "image/png", value: "aW1hZ2U=" },
    metadata: { filename: "photo.png", width: 20 },
  },
  {
    type: "document",
    source: {
      type: "url",
      mimeType: "application/pdf",
      value: "http://127.0.0.1/file.pdf",
    },
    metadata: { filename: "file.pdf" },
  },
  {
    type: "video",
    source: { type: "data", mimeType: "video/mp4", value: "dmlkZW8=" },
    metadata: { filename: "clip.mp4" },
  },
];

describe("multimodal snapshot fidelity", () => {
  it.each(attachments)("preserves $type parts and metadata", (attachment) => {
    const message: UserMessage = {
      id: "u1",
      role: "user",
      metadata: { origin: "upload" },
      content: [{ type: "text", text: "Describe this file" }, attachment],
    };
    expect(buildSnapshotMessages([message])).toEqual([message]);
  });

  it("preserves attachments in every snapshot, including failed media and history", async () => {
    const orderedAttachments = [
      ...attachments.filter((attachment) => attachment.type !== "document"),
      ...attachments.filter((attachment) => attachment.type === "document"),
    ];
    const messages: UserMessage[] = orderedAttachments.map(
      (attachment, index) => ({
        id: `u${index}`,
        role: "user",
        metadata: { origin: "upload" },
        content: [{ type: "text", text: "Describe this file" }, attachment],
      }),
    );
    // Default policy refusal avoids network access while exercising a real
    // dropped URL attachment. The snapshot must still retain the user's file.
    const agent = scriptedStrandsAgent([stream.textDelta("response")]);
    const events = await collect(agent, minimalRunInput({ messages }));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: EventType.CUSTOM,
        name: "MediaDropped",
        value: {
          dropped: [
            { type: "document", reason: "content could not be resolved" },
          ],
          delivered: 0,
        },
      }),
    );
    const snapshots = events.filter(
      (event) => event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        messages: expect.arrayContaining(messages),
      });
    }
  });
});
