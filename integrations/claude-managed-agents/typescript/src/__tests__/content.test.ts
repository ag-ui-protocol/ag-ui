import { describe, expect, it } from "vitest";
import {
  EventType,
  type RunAgentInput,
  type InputContent,
} from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { userContent } from "../content";
import { ManagedAgentsAgent } from "../agent";
import { createFakeClient } from "./fake-client";

const idle = {
  type: "session.status_idle",
  id: "idle",
  stop_reason: { type: "end_turn" },
};
const run = async (parts: InputContent[], native: unknown[] = []) => {
  const fake = createFakeClient({ streams: [[...native, idle]] });
  const agent = new ManagedAgentsAgent({
    managedAgentId: "a",
    environmentId: "e",
    client: fake.client,
  });
  const input: RunAgentInput = {
    threadId: "t",
    runId: "r",
    state: { cart: { total: 42 } },
    messages: [{ id: "original-user", role: "user", content: parts }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const events = JSON.parse(
    JSON.stringify(await lastValueFrom(agent.run(input).pipe(toArray()))),
  );
  return { fake, input, events };
};

describe("lossless live conversation", () => {
  it.each(["image", "document"] as const)(
    "preserves %s sources and filenames in the recorder input",
    async (type) => {
      const mimeType = type === "image" ? "image/png" : "application/pdf";
      const parts: InputContent[] = [
        {
          type,
          source: { type: "data", value: "AAEC/w==", mimeType },
          metadata: { filename: "original.bin" },
        },
        {
          type,
          source: {
            type: "url",
            value: "https://example.test/media",
            mimeType,
          },
          metadata: { filename: "remote.bin" },
        },
        {
          type,
          source: {
            type: "file",
            value: "file_native",
            provider: "anthropic",
            mimeType,
          },
        },
      ];
      const { events, input, fake } = await run(parts);
      expect(events[0].input).toEqual(input);
      expect(
        events.find(
          (event: { type: string }) => event.type === EventType.STATE_SNAPSHOT,
        ),
      ).toMatchObject({
        type: EventType.STATE_SNAPSHOT,
        snapshot: input.state,
      });
      expect(fake.sent[0].events[0]).toMatchObject({
        content: [
          {
            type,
            source: { type: "base64", data: "AAEC/w==", media_type: mimeType },
          },
          { type, source: { type: "url", url: "https://example.test/media" } },
          { type, source: { type: "file", file_id: "file_native" } },
        ],
      });
      expect(events.at(-1).type).toBe(EventType.RUN_FINISHED);
    },
  );

  it.each(["audio", "video"] as const)(
    "records unsupported %s while sending supported parts",
    async (type) => {
      const { events, input, fake } = await run([
        { type: "text", text: "  describe\n" },
        {
          type,
          source: { type: "data", value: "AAEC", mimeType: `${type}/test` },
          metadata: { filename: "original" },
        },
      ]);
      expect(events[0].input).toEqual(input);
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
      });
      expect(fake.sent[0].events[0]).toMatchObject({
        content: [{ type: "text", text: "  describe\n" }],
      });
    },
  );

  it("refuses foreign provider handles without changing their meaning", async () => {
    const { events, fake } = await run([
      {
        type: "image",
        source: { type: "file", value: "opaque", provider: "openai" },
      },
    ]);
    expect(events.at(-1).code).toBe("empty_run");
    expect(fake.sent).toEqual([]);
  });

  it("records full MCP results and unknown rich events with original identities", async () => {
    const content = [
      { type: "text", text: "  " + "x".repeat(30000) + "\n" },
      {
        type: "image",
        source: { type: "base64", data: "AAEC/w==", media_type: "image/png" },
      },
      {
        type: "search_result",
        title: "A &amp; B",
        source: "https://example.test",
        content: [{ type: "text", text: "y".repeat(2000) }],
      },
    ];
    const native = [
      {
        type: "agent.mcp_tool_result",
        id: "original-result",
        mcp_tool_use_id: "original-call",
        is_error: true,
        content,
      },
      { type: "agent.future_rich_event", id: "rich", payload: { ui: [1, 2] } },
    ];
    const { events } = await run([{ type: "text", text: "hello" }], native);
    expect(
      events
        .filter((e: any) => e.type === EventType.RAW)
        .map((e: any) => e.event),
    ).toEqual(native);
    const result = events.find(
      (e: any) => e.type === EventType.TOOL_CALL_RESULT,
    );
    expect(result).toMatchObject({
      messageId: "original-result",
      toolCallId: "original-call",
    });
    expect(
      result.content.map((part: any) => part.metadata.claudeManagedAgents),
    ).toEqual(content);
    expect(
      result.content.every((part: any) => part.metadata.isError === true),
    ).toBe(true);
    expect(result.content[1]).toMatchObject({
      type: "image",
      source: { type: "data", value: "AAEC/w==", mimeType: "image/png" },
    });
  });
});

it("keeps blank separators inside meaningful user text", async () => {
  const parts: InputContent[] = [
    { type: "text", text: "START" },
    { type: "text", text: "\n" },
    { type: "text", text: "END" },
  ];
  const { fake, events, input } = await run(parts);
  expect(fake.sent[0].events[0]).toMatchObject({ content: parts });
  expect(events[0].input).toEqual(input);
  expect(events.at(-1).type).toBe(EventType.RUN_FINISHED);
});

it("keeps blank text alongside supported user media", async () => {
  const { fake, events } = await run([
    {
      type: "image",
      source: { type: "url", value: "https://example.test/image" },
    },
    { type: "text", text: " \n" },
  ]);
  expect(fake.sent[0].events[0]).toMatchObject({
    content: [
      {
        type: "image",
        source: { type: "url", url: "https://example.test/image" },
      },
      { type: "text", text: " \n" },
    ],
  });
  expect(events.at(-1).type).toBe(EventType.RUN_FINISHED);
});

it.each([false, true])(
  "sends UTF-8 text documents with original recorder bytes (mixed=%s)",
  async (mixed) => {
    const text = "\uFEFF  café 日本語 😀\r\nPARITY42\n";
    const document: InputContent = {
      type: "document",
      source: {
        type: "data",
        value: Buffer.from(text).toString("base64"),
        mimeType: "text/plain",
      },
      metadata: { filename: "note.txt" },
    };
    const parts: InputContent[] = [document];
    if (mixed)
      parts.push(
        {
          type: "image",
          source: { type: "data", value: "AAEC/w==", mimeType: "image/png" },
        },
        {
          type: "document",
          source: {
            type: "data",
            value: "JVBERi0=",
            mimeType: "application/pdf",
          },
        },
        {
          type: "audio",
          source: { type: "data", value: "AAEC", mimeType: "audio/wav" },
        },
      );
    const original = JSON.parse(JSON.stringify(parts));
    const { events, fake } = await run(parts);
    expect(events[0].input.messages[0].content).toEqual(original);
    expect(parts).toEqual(original);
    const blocks = userContent({ id: "user", role: "user", content: parts });
    expect(fake.sent[0].events[0]).toMatchObject({ content: blocks });
    expect(blocks[0]).toEqual({
      type: "document",
      title: "note.txt",
      source: { type: "text", media_type: "text/plain", data: text },
    });
    expect(blocks).toHaveLength(mixed ? 3 : 1);
    if (mixed)
      expect(blocks.slice(1)).toEqual([
        {
          type: "image",
          source: { type: "base64", data: "AAEC/w==", media_type: "image/png" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            data: "JVBERi0=",
            media_type: "application/pdf",
          },
        },
      ]);
    expect(events.at(-1).type).toBe(EventType.RUN_FINISHED);
  },
);

it.each(["%%%", "/w=="])(
  "rejects malformed text attachment %s without replacing bytes",
  async (value) => {
    const parts: InputContent[] = [
      {
        type: "document",
        source: { type: "data", value, mimeType: "text/plain" },
        metadata: { filename: "invalid.txt" },
      },
    ];
    const original = JSON.parse(JSON.stringify(parts));
    const { events, fake } = await run(parts);
    expect(events[0].input.messages[0].content).toEqual(original);
    expect(events.at(-1).type).toBe(EventType.RUN_ERROR);
    expect(fake.sent).toEqual([]);
  },
);

it.each([true, false])(
  "preserves native denial status %s with canonical identity and text",
  async (isError) => {
    const text = "Permission to use read has been rejected.";
    const { events } = await run(
      [{ type: "text", text: "hello" }],
      [
        {
          type: "agent.tool_result",
          id: "native-result",
          tool_use_id: "native-call",
          is_error: isError,
          content: [{ type: "text", text }],
        },
      ],
    );
    const results = events.filter(
      (event: any) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      messageId: "native-result",
      toolCallId: "native-call",
    });
    expect(
      isError ? JSON.parse(results[0].content) : results[0].content,
    ).toEqual(isError ? { error: true, content: text } : text);
    expect(events.at(-1).type).toBe(EventType.RUN_FINISHED);
  },
);
