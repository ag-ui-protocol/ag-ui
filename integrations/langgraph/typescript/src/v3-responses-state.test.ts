import { expect, it, vi } from "vitest";
import fixture from "./__fixtures__/openai-responses-native-state.json";
import { v3StateToV2 } from "./v3-state";
import { aguiTransformer } from "./transformer/agui-transformer";
import type { ProcessedEvents } from "./types";

// Captured from the patched native Responses converter and its V2 converter
// consuming the same raw provider stream. Indices deliberately differ from
// both zero and their positions in the standardized content block array.
const native = { ...fixture.native.kwargs, type: "ai" };
const legacy = { ...fixture.legacy.kwargs, type: "ai" };

it("projects the actual Responses stream assembly to its V2 message", () => {
  const before = structuredClone(native);
  expect(v3StateToV2({ messages: [native] })).toEqual({ messages: [legacy] });
  expect(native).toEqual(before);
  expect(v3StateToV2({ messages: [legacy] })).toEqual({ messages: [legacy] });
});

it.each([
  { model_provider: "other" },
  { output_version: "v2" },
  { object: "chat.completion" },
])("preserves content outside the Responses v1 contract: %j", (metadata) => {
  const message = {
    ...native,
    response_metadata: { ...native.response_metadata, ...metadata },
  };
  expect(v3StateToV2({ messages: [message] })).toEqual({ messages: [message] });
});

it.each([
  {
    content: [{ type: "reasoning", reasoning: "thinking", id: "provider-id" }],
  },
  { content: [{ type: "text", text: "answer" }] },
  {
    content: [
      { type: "reasoning", reasoning: "thinking", index: "provider-index" },
    ],
  },
  {
    content: [
      {
        type: "reasoning",
        reasoning: "thinking",
        index: 3,
        encrypted_content: "encrypted",
      },
    ],
  },
  {
    content: [
      {
        type: "text",
        text: "answer",
        index: 5,
        annotations: [{ type: "citation", url: "source" }],
      },
    ],
  },
  { content: [{ type: "redacted_reasoning", data: "encrypted", index: 3 }] },
])(
  "does not infer missing indices or discard unsupported rich fields: %j",
  ({ content }) => {
    const message = { ...native, content, content_blocks: content };
    expect(v3StateToV2({ messages: [message] })).toEqual({
      messages: [message],
    });
  },
);

it("preserves encrypted provider data and provider identity without mutation", () => {
  const additional_kwargs = {
    ...native.additional_kwargs,
    reasoning: {
      ...native.additional_kwargs.reasoning,
      encrypted_content: "encrypted-provider-data",
    },
  };
  const message = { ...native, additional_kwargs };
  const before = structuredClone(message);
  expect(v3StateToV2({ messages: [message] })).toEqual({
    messages: [{ ...legacy, additional_kwargs }],
  });
  expect(message).toEqual(before);
});

it("uses the conversion for the final transformer state snapshot", async () => {
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  transformer.process({
    type: "event",
    seq: 0,
    method: "values",
    params: {
      namespace: [],
      timestamp: 0,
      data: { messages: [native] },
    },
  });
  transformer.finalize?.();
  expect(events.find((event) => event.type === "STATE_SNAPSHOT")).toEqual({
    type: "STATE_SNAPSHOT",
    snapshot: { messages: [legacy] },
  });
});

it("preserves the complete native message when a block's sole provider identity would be lost", () => {
  const message = {
    ...native,
    response_metadata: { ...native.response_metadata, output: [] },
  };
  expect(v3StateToV2({ messages: [message] })).toEqual({ messages: [message] });
});

it("does not count an unrelated output item as preserving a block identity", () => {
  const message = {
    ...native,
    response_metadata: {
      ...native.response_metadata,
      output: [{ type: "reasoning", id: "message_9", summary: [] }],
    },
  };
  expect(v3StateToV2({ messages: [message] })).toEqual({ messages: [message] });
});

it("keeps Responses stream reasoning identity separate from persisted provider item identity", async () => {
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  for (const [seq, data] of fixture.events.entries()) {
    transformer.process({
      type: "event",
      seq,
      method: "messages",
      params: {
        namespace: [],
        timestamp: 0,
        data,
      },
    });
  }
  transformer.process({
    type: "event",
    seq: fixture.events.length,
    method: "values",
    params: {
      namespace: [],
      timestamp: 0,
      data: { messages: [native] },
    },
  });
  transformer.finalize?.();
  const start = events.find((event) => event.type === "REASONING_START");
  expect(start?.type).toBe("REASONING_START");
  if (start?.type !== "REASONING_START")
    throw new Error("Reasoning did not stream");
  expect(start.messageId).not.toBe(native.additional_kwargs.reasoning.id);
  expect(
    events.find(
      (event) =>
        event.type === "STATE_SNAPSHOT" && event.snapshot.messages?.length,
    ),
  ).toEqual({
    type: "STATE_SNAPSHOT",
    snapshot: { messages: [legacy] },
  });
  const end = events.find((event) => event.type === "REASONING_END");
  expect(end).toEqual({ type: "REASONING_END", messageId: start.messageId });
});

it("preserves another provider's reasoning ID after an OpenAI Responses message", async () => {
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  for (const data of [
    ...fixture.events,
    { event: "message-start", id: "other-message" },
    { event: "provider", provider: "other", name: "response.created" },
    {
      event: "content-block-start",
      index: 0,
      content: {
        type: "reasoning",
        reasoning: "Other",
        id: "other-provider-reasoning",
      },
    },
  ])
    transformer.process({
      type: "event",
      seq: 0,
      method: "messages",
      params: { namespace: [], timestamp: 0, data },
    });
  expect(
    events.filter((event) => event.type === "REASONING_START").at(-1),
  ).toEqual({
    type: "REASONING_START",
    messageId: "other-provider-reasoning",
  });
});
