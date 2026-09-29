import { EventType } from "@ag-ui/core";
import type { ProtocolEvent } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { aguiTransformer } from "./agui-transformer";
import type { ProcessedEvents } from "../types";

async function harness() {
  const transformer = aguiTransformer();
  const { agui } = await transformer.init();
  const events: ProcessedEvents[] = [];
  vi.spyOn(agui, "push").mockImplementation((event) => {
    if (
      event.type !== EventType.CUSTOM ||
      event.name !== "__ag_ui_transformer_status__"
    )
      events.push(event);
  });
  const process = (method: string, data: object, namespace: string[] = []) => {
    const event: ProtocolEvent = {
      type: "event",
      seq: 0,
      method,
      params: { namespace, timestamp: 0, data },
    };
    transformer.process(event);
  };
  return { transformer, events, process };
}

const human = { id: "human", type: "human", content: "Hi" };
const assistant = {
  id: "assistant",
  type: "ai",
  content: "Hello",
  tool_calls: [],
};
const initial = { messages: [human], copilotkit: { actions: [] } };
const complete = { ...initial, messages: [human, assistant] };

function greeting(process: Awaited<ReturnType<typeof harness>>["process"]) {
  process("values", initial);
  process("tasks", { id: "before", name: "before_agent", input: initial });
  process("tasks", {
    id: "before",
    name: "before_agent",
    result: { messages: [human] },
  });
  process("values", initial);
  process("tasks", { id: "model", name: "model", input: initial });
  process("lifecycle", { event: "started" }, ["model:model"]);
  process("tasks", {
    id: "model",
    name: "model",
    output_type: "Object",
    result: { messages: [assistant] },
  });
  process("lifecycle", { event: "completed" }, ["model:model"]);
  process("values", complete);
  process("tasks", { id: "after", name: "after_model", input: complete });
  process("tasks", { id: "after", name: "after_model", result: {} });
  process("tasks", { id: "end", name: "after_agent", input: complete });
  process("tasks", { id: "end", name: "after_agent", result: {} });
  process("values", complete);
  process("lifecycle", { event: "completed" });
}

describe("transformer task parity", () => {
  it.each(["Object", "Command", "Array", undefined])(
    "orders equal result/reduced state using genuine return provenance %s",
    async (output_type) => {
      const { events, process } = await harness();
      process("values", { count: 0 });
      process("tasks", {
        id: "producer",
        name: "producer",
        input: { count: 0 },
      });
      process("tasks", {
        id: "producer",
        name: "producer",
        result: { count: 1 },
        ...(output_type ? { output_type } : {}),
      });
      process("values", { count: 1 });
      process("tasks", {
        id: "consumer",
        name: "consumer",
        input: { count: 1 },
      });
      const boundary = events.slice(3);
      const snapshot = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { count: 1 },
      };
      const finish = { type: EventType.STEP_FINISHED, stepName: "producer" };
      const start = { type: EventType.STEP_STARTED, stepName: "consumer" };
      expect(boundary).toEqual(
        output_type === "Object"
          ? [snapshot, finish, start]
          : [finish, start, snapshot],
      );
    },
  );

  it("waits for reduced state when return provenance is absent", async () => {
    const { events, process } = await harness();
    process("values", initial);
    process("tasks", { id: "producer", name: "producer", input: initial });
    process("tasks", {
      id: "producer",
      name: "producer",
      result: { messages: [assistant] },
    });
    process("values", complete);
    process("tasks", { id: "consumer", name: "consumer", input: complete });
    expect(
      events
        .filter((event) => event.type === EventType.STATE_SNAPSHOT)
        .map((event) => event.snapshot),
    ).toEqual([{}, initial, complete]);
  });

  it("opens each run with empty state before its first root task input", async () => {
    const { events, process } = await harness();
    process("values", initial);
    process("tasks", { id: "first", name: "before_agent", input: initial });
    process("tasks", { id: "first", name: "before_agent", result: {} });
    process("tasks", { id: "second", name: "model", input: initial });
    expect(events).toEqual([
      { type: EventType.STEP_STARTED, stepName: "before_agent" },
      { type: EventType.STATE_SNAPSHOT, snapshot: {} },
      { type: EventType.STATE_SNAPSHOT, snapshot: initial },
      { type: EventType.STEP_FINISHED, stepName: "before_agent" },
      { type: EventType.STEP_STARTED, stepName: "model" },
    ]);
  });
  it("does not publish temporary top-level mutations of live task input", async () => {
    const { events, process } = await harness();
    process("values", initial);
    process("tasks", {
      id: "task",
      name: "resume",
      input: { ...initial, temporary: "node-local" },
    });
    process("messages", { event: "message-start", id: "assistant" });
    const snapshots = events.filter(
      (event) => event.type === EventType.STATE_SNAPSHOT,
    );
    expect(snapshots).toEqual([
      { type: EventType.STATE_SNAPSHOT, snapshot: {} },
      { type: EventType.STATE_SNAPSHOT, snapshot: initial },
    ]);
  });
  it("keeps the reserved interrupt envelope out of graph state", async () => {
    const { events, process } = await harness();
    process("values", initial);
    process("values", {
      __interrupt__: [{ id: "interrupt", value: "approve" }],
    });
    process("lifecycle", { event: "completed" });
    expect(
      events.find((event) => event.type === EventType.STATE_SNAPSHOT),
    ).toEqual({ type: EventType.STATE_SNAPSHOT, snapshot: initial });
  });
  it("emits backend tool results and errors while it owns the stream", async () => {
    const { events, process } = await harness();
    process("tools", {
      event: "tool-finished",
      tool_call_id: "call",
      output: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
        status: "success",
      },
    });
    process("tools", {
      event: "tool-error",
      tool_call_id: "failed",
      message: "Unavailable",
    });
    expect(events).toEqual([
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "call",
        content: "firstsecond",
        messageId: expect.any(String),
        role: "tool",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "failed",
        content: "Unavailable",
        messageId: expect.any(String),
        role: "tool",
      },
    ]);
  });
  it("serializes live LangChain messages without leaking class internals or stale tool calls", async () => {
    const { events, process } = await harness();
    const message = new AIMessage({
      content: "Hello",
      id: "assistant",
      tool_calls: [],
    });
    // Middleware can restore tool linkage by mutating the live message after
    // construction; the constructor kwargs are not the canonical message.
    message.tool_calls = [{ id: "call", name: "frontend", args: {} }];
    process("values", { messages: [message] });
    process("lifecycle", { event: "completed" });
    expect(events.find((e) => e.type === EventType.STATE_SNAPSHOT)).toEqual({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        messages: [
          {
            id: "assistant",
            type: "ai",
            content: "Hello",
            additional_kwargs: {},
            response_metadata: {},
            tool_calls: message.tool_calls,
            invalid_tool_calls: [],
          },
        ],
      },
    });
    expect(
      events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toMatchObject({
      messages: [
        {
          toolCalls: [
            { id: "call", function: { name: "frontend", arguments: "{}" } },
          ],
        },
      ],
    });
  });
  it("owns the first task before raw V3 can open it and preserves provisional V2 snapshots", async () => {
    const { events, process } = await harness();
    greeting(process);
    expect(events).toEqual([
      { type: EventType.STEP_STARTED, stepName: "before_agent" },
      { type: EventType.STATE_SNAPSHOT, snapshot: {} },
      { type: EventType.STATE_SNAPSHOT, snapshot: initial },
      { type: EventType.STEP_FINISHED, stepName: "before_agent" },
      { type: EventType.STEP_STARTED, stepName: "model" },
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { ...initial, messages: [assistant] },
      },
      { type: EventType.STEP_FINISHED, stepName: "model" },
      { type: EventType.STEP_STARTED, stepName: "after_model" },
      { type: EventType.STATE_SNAPSHOT, snapshot: complete },
      { type: EventType.STEP_FINISHED, stepName: "after_model" },
      { type: EventType.STEP_STARTED, stepName: "after_agent" },
      { type: EventType.STEP_FINISHED, stepName: "after_agent" },
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "human", role: "user", content: "Hi" },
          {
            id: "assistant",
            role: "assistant",
            content: "Hello",
            toolCalls: [],
          },
        ],
      },
    ]);
  });

  it("keeps concurrent tasks sharing a name open until both finish", async () => {
    const { events, process } = await harness();
    process("tasks", { id: "one", name: "worker", input: {} });
    process("tasks", { id: "two", name: "worker", input: {} });
    process("tasks", { id: "one", name: "worker", result: {} });
    expect(events.filter((e) => e.type === EventType.STEP_FINISHED)).toEqual(
      [],
    );
    process("tasks", { id: "two", name: "worker", result: {} });
    process("lifecycle", { event: "completed" });
    expect(
      events.filter(
        (e) =>
          e.type === EventType.STEP_STARTED ||
          e.type === EventType.STEP_FINISHED,
      ),
    ).toEqual([
      { type: EventType.STEP_STARTED, stepName: "worker" },
      { type: EventType.STEP_FINISHED, stepName: "worker" },
    ]);
  });

  it("never snapshots provisional tool interception as the canonical message history", async () => {
    const { events, process } = await harness();
    const call = {
      ...assistant,
      content: "",
      tool_calls: [{ id: "call", name: "frontend", args: {} }],
    };
    process("values", initial);
    process("tasks", { id: "model", name: "model", input: initial });
    process("messages", { event: "message-start", id: "assistant" });
    process("messages", {
      event: "content-block-start",
      index: 0,
      content: { type: "tool_call", id: "call", name: "frontend", args: "{}" },
    });
    process("messages", { event: "message-finish" });
    process("tasks", {
      id: "model",
      name: "model",
      result: { messages: [call] },
    });
    process("values", complete); // middleware temporarily intercepts the tool call
    process("tasks", { id: "after", name: "after_agent", input: complete });
    process("tasks", {
      id: "after",
      name: "after_agent",
      result: { messages: [call] },
    });
    process("values", { ...initial, messages: [human, call] });
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toEqual([]);
    process("lifecycle", { event: "completed" });
    expect(
      events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toEqual([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "human", role: "user", content: "Hi" },
          {
            id: "assistant",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call",
                type: "function",
                function: { name: "frontend", arguments: "{}" },
              },
            ],
          },
        ],
      },
    ]);
  });
});
