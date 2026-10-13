import { expect, it, vi } from "vitest";
import {
  Annotation,
  StateGraph,
  START,
  type ProtocolEvent,
} from "@langchain/langgraph";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { aguiTransformer } from "./agui-transformer";
import type { ProcessedEvents, V3MessageEvent } from "../types";

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function harness() {
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    events.push(event);
  });
  const process = (
    method: ProtocolEvent["method"],
    data: ProtocolEvent["params"]["data"],
    namespace: string[] = [],
  ) =>
    transformer.process({
      type: "event",
      seq: 0,
      method,
      params: { timestamp: 0, namespace, data },
    });
  return { transformer, events, process };
}

function expectBalancedMessages(events: ProcessedEvents[]) {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "TEXT_MESSAGE_START") {
      expect(active.has(event.messageId)).toBe(false);
      active.add(event.messageId);
    } else if (event.type === "TEXT_MESSAGE_CONTENT") {
      expect(active.has(event.messageId)).toBe(true);
    } else if (event.type === "TEXT_MESSAGE_END") {
      expect(active.delete(event.messageId)).toBe(true);
    }
  }
  expect([...active]).toEqual([]);
}

it("keeps two real parallel model streams independent at content index zero", async () => {
  const leftFirst = gate();
  const rightFirst = gate();
  const leftSecond = gate();
  class ParallelModel extends BaseChatModel {
    constructor(readonly side: "L" | "R") {
      super({});
    }
    _llmType() {
      return "parallel-regression";
    }
    async _generate(): Promise<never> {
      throw new Error("Expected streaming");
    }
    async *_streamResponseChunks() {
      if (this.side === "R") await leftFirst.ready;
      yield new ChatGenerationChunk({
        text: `${this.side}0`,
        message: new AIMessageChunk({
          id: this.side,
          content: `${this.side}0`,
        }),
      });
      await (this.side === "L" ? rightFirst.ready : leftSecond.ready);
      yield new ChatGenerationChunk({
        text: `${this.side}1`,
        message: new AIMessageChunk({
          id: this.side,
          content: `${this.side}1`,
        }),
      });
    }
  }
  const State = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (left, right) => left.concat(right),
      default: () => [],
    }),
  });
  const left = new ParallelModel("L");
  const right = new ParallelModel("R");
  const graph = new StateGraph(State)
    .addNode("left", async (state) => ({
      messages: [await left.invoke(state.messages)],
    }))
    .addNode("right", async (state) => ({
      messages: [await right.invoke(state.messages)],
    }))
    .addEdge(START, "left")
    .addEdge(START, "right")
    .compile();
  const { transformer, events } = await harness();
  const deltas: string[] = [];
  for await (const event of await graph.streamEvents(
    { messages: [new HumanMessage("hi")] },
    { version: "v3" },
  )) {
    transformer.process(event);
    const data = event.params.data;
    if (
      event.method === "messages" &&
      data &&
      typeof data === "object" &&
      "delta" in data &&
      data.delta &&
      typeof data.delta === "object" &&
      "text" in data.delta
    ) {
      const text = data.delta.text;
      if (typeof text === "string") deltas.push(text);
      if (text === "L0") leftFirst.release();
      if (text === "R0") rightFirst.release();
      if (text === "L1") leftSecond.release();
    }
  }
  transformer.finalize?.();
  expect(deltas).toEqual(["L0", "R0", "L1", "R1"]);
  const content = new Map<string, string>();
  for (const event of events)
    if (event.type === "TEXT_MESSAGE_CONTENT")
      content.set(
        event.messageId,
        (content.get(event.messageId) ?? "") + event.delta,
      );
  expect(Object.fromEntries(content)).toEqual({ L: "L0L1", R: "R0R1" });
  expectBalancedMessages(events);
});

it.each([
  ["message-finish", true],
  ["message-error", true],
  ["finalize", true],
  ["message-finish", false],
] as const)(
  "isolates interleaved reasoning, deferred tools and predictions on %s (provider IDs: %s)",
  async (terminal, providerIds) => {
    const { transformer, events } = await harness();
    const prediction = (side: string) => [
      { state_key: side, tool: `tool-${side}`, tool_argument: "value" },
    ];
    const send = (
      side: string,
      data: V3MessageEvent & {
        metadata?: { predict_state: ReturnType<typeof prediction> };
      },
    ) =>
      transformer.process({
        type: "event",
        seq: 0,
        method: "messages",
        params: {
          timestamp: 0,
          namespace: [side],
          data: { ...data, run_id: "shared-run" },
        },
      });
    for (const side of ["L", "R"]) {
      send(side, {
        event: "message-start",
        id: side,
        metadata: { predict_state: prediction(side) },
      });
      send(side, {
        event: "content-block-start",
        index: 0,
        content: { type: "reasoning" },
      });
      send(side, {
        event: "content-block-start",
        index: 1,
        content: {
          type: "tool_call_chunk",
          ...(providerIds ? { id: `call-${side}` } : {}),
          args: '{"value":',
        },
      });
    }
    for (const side of ["L", "R"]) {
      send(side, {
        event: "content-block-delta",
        index: 0,
        delta: { type: "reasoning-delta", reasoning: `${side}-thought` },
      });
      send(side, {
        event: "content-block-delta",
        index: 1,
        delta: {
          type: "block-delta",
          fields: { name: `tool-${side}`, args: '{"value":1}' },
        },
      });
      if (terminal !== "finalize") send(side, { event: terminal });
    }
    transformer.finalize?.();
    for (const side of ["L", "R"]) {
      const reasoning = events.filter(
        (event) =>
          "messageId" in event && event.messageId === `${side}-reasoning-0`,
      );
      expect(reasoning.map((event) => event.type)).toEqual([
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
      ]);
      expect(reasoning[2]).toMatchObject({ delta: `${side}-thought` });
      const toolId = providerIds ? `call-${side}` : `${side}:tc:1`;
      const tool = events.filter(
        (event) => "toolCallId" in event && event.toolCallId === toolId,
      );
      expect(tool[0]).toMatchObject({
        type: "TOOL_CALL_START",
        toolCallName: `tool-${side}`,
        parentMessageId: side,
      });
      expect(tool.at(-1)?.type).toBe("TOOL_CALL_END");
      expect(
        tool
          .filter((event) => event.type === "TOOL_CALL_ARGS")
          .map((event) => event.delta)
          .join(""),
      ).toBe('{"value":1}');
      expect(events).toContainEqual({
        type: "CUSTOM",
        name: "PredictState",
        value: prediction(side),
      });
    }
  },
);

it("keeps snapshots suppressed until all predicted tools finish", async () => {
  const { process, events } = await harness();
  process("values", { value: "before" });
  for (const side of ["L", "R"]) {
    process("messages", {
      event: "message-start",
      run_id: side,
      id: side,
      metadata: {
        predict_state: [
          { state_key: "value", tool: side, tool_argument: "value" },
        ],
      },
    });
    process("messages", {
      event: "content-block-start",
      run_id: side,
      index: 0,
      content: { type: "tool_call_chunk", id: side, name: side },
    });
    process("messages", { event: "message-finish", run_id: side });
  }
  process("values", { value: "after" });
  for (const tool of ["unrelated", "L"]) {
    process("tools", {
      event: "tool-finished",
      tool_call_id: tool,
      output: "done",
    });
    process("messages", {
      event: "message-start",
      run_id: tool,
      id: `next-${tool}`,
    });
    expect(
      events.filter((event) => event.type === "STATE_SNAPSHOT"),
    ).toHaveLength(1);
  }
  process("tools", {
    event: "tool-finished",
    tool_call_id: "R",
    output: "done",
  });
  process("messages", { event: "message-start", run_id: "next", id: "next" });
  expect(events.filter((event) => event.type === "STATE_SNAPSHOT")).toEqual([
    { type: "STATE_SNAPSHOT", snapshot: { value: "before" } },
    { type: "STATE_SNAPSHOT", snapshot: { value: "after" } },
  ]);
});

it("keeps a sibling's snapshot reasoning when another model streams reasoning", async () => {
  const { transformer, process, events } = await harness();
  process("messages", { event: "message-start", run_id: "left", id: "L" });
  process("messages", {
    event: "content-block-start",
    run_id: "left",
    index: 0,
    content: { type: "reasoning", id: "rs-left", reasoning: "streamed" },
  });
  process("messages", { event: "message-finish", run_id: "left" });
  process("values", {
    messages: [
      {
        id: "L",
        type: "ai",
        content: "answer",
        additional_kwargs: {
          reasoning: { id: "rs-left", summary: [{ text: "streamed" }] },
        },
      },
      {
        id: "R",
        type: "ai",
        content: "answer",
        additional_kwargs: {
          reasoning: { id: "rs-right", summary: [{ text: "snapshot" }] },
        },
      },
    ],
  });
  transformer.finalize?.();
  expect(
    events.filter((event) => event.type === "REASONING_MESSAGE_CONTENT"),
  ).toEqual([
    {
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "rs-left",
      delta: "streamed",
    },
    {
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "rs-right",
      delta: "snapshot",
    },
  ]);
});

it("closes completed nested node text at the next producer without closing a live model", async () => {
  const { transformer, process, events } = await harness();
  process("messages", { event: "message-start", run_id: "live", id: "live" });
  process("messages", {
    event: "content-block-delta",
    run_id: "live",
    index: 0,
    delta: { type: "text-delta", text: "before" },
  });
  process("tasks", { id: "child", name: "child", input: {} }, ["outer:task"]);
  const namespace = ["outer:task", "child:task"];
  for (const text of ["one", "two"]) {
    process(
      "messages",
      {
        event: "message-start",
        run_id: "node",
        id: text,
        metadata: { langgraph_message_source: "node" },
      },
      namespace,
    );
    process(
      "messages",
      {
        event: "content-block-delta",
        run_id: "node",
        index: 0,
        delta: { type: "text-delta", text },
      },
      namespace,
    );
    process("messages", { event: "message-finish", run_id: "node" }, namespace);
  }
  expect(events.filter((event) => event.type === "TEXT_MESSAGE_END")).toEqual(
    [],
  );
  process("messages", {
    event: "message-start",
    run_id: "next",
    id: "next",
    metadata: { langgraph_message_source: "model" },
  });
  expect(events.filter((event) => event.type === "TEXT_MESSAGE_END")).toEqual([
    { type: "TEXT_MESSAGE_END", messageId: "one" },
  ]);
  process("messages", {
    event: "content-block-delta",
    run_id: "live",
    index: 0,
    delta: { type: "text-delta", text: "after" },
  });
  process("messages", { event: "message-finish", run_id: "live" });
  transformer.finalize?.();
  expect(
    events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT"),
  ).toEqual([
    { type: "TEXT_MESSAGE_CONTENT", messageId: "live", delta: "before" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "one" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "one", delta: "two" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "live", delta: "after" },
  ]);
  expectBalancedMessages(events);
});
