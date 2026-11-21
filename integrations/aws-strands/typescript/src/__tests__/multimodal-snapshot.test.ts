import { describe, expect, it } from "vitest";
import {
  EventType,
  type InputContent,
  type ToolMessage,
  type UserMessage,
} from "@ag-ui/core";
import { MessagesSnapshotEventSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
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
  {
    type: "audio",
    source: { type: "data", mimeType: "audio/wav", value: "UklGRiQAAABXQVZF" },
    metadata: { filename: "voice.wav" },
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

describe("tool message parts in the snapshot", () => {
  const toolParts: InputContent[] = [
    { type: "text", text: "here is the chart" },
    {
      type: "image",
      source: { type: "data", mimeType: "image/png", value: "iVBORw==" },
    },
  ];

  it("keeps a tool message's list of parts as a list", () => {
    const message: ToolMessage = {
      id: "tool-1",
      role: "tool",
      toolCallId: "call-1",
      content: toolParts,
    };
    expect(buildSnapshotMessages([message])).toEqual([message]);
  });

  it("returns string content unchanged", () => {
    // Most frontends send a tool result as a JSON string. The snapshot echoes
    // it as it came and does not parse it.
    const message: ToolMessage = {
      id: "tool-1",
      role: "tool",
      toolCallId: "call-1",
      content: '{"accepted":true,"steps":["a","b"]}',
    };
    expect(buildSnapshotMessages([message])).toEqual([message]);
  });

  it("turns an unexpected content type into text", () => {
    const message = {
      id: "tool-1",
      role: "tool",
      toolCallId: "call-1",
      content: 42,
    } as unknown as ToolMessage;
    expect(buildSnapshotMessages([message])).toEqual([
      { ...message, content: "42" },
    ]);
  });

  it("sends the client's tool parts back on the wire", async () => {
    const agent = scriptedStrandsAgent([stream.textDelta("response")]);
    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "show me the chart" },
          {
            id: "a1",
            role: "assistant",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "chart", arguments: "{}" },
              },
            ],
          },
          {
            id: "tool-1",
            role: "tool",
            toolCallId: "call-1",
            content: toolParts,
          },
          { id: "u2", role: "user", content: "thanks" },
        ],
      }),
    );
    const snapshot = events.find(
      (event) => event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(snapshot).toBeDefined();
    // Encoded the way the endpoint sends it, then read back and validated the
    // way a client does.
    const sse = new EventEncoder().encodeSSE(snapshot!);
    const wire = MessagesSnapshotEventSchema.parse(
      JSON.parse(sse.slice("data: ".length)),
    );
    const tools = wire.messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.content).toEqual(toolParts);
  });
});
