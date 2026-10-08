import { EventType, type Message } from "@ag-ui/core";
import type { ProtocolEvent } from "@langchain/langgraph";
import { SubscriptionHandle, type ThreadState } from "@langchain/langgraph-sdk";
import { Subscriber } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import type { State } from "./types";

const human = { id: "human", type: "human", content: "Hi, I am duaa" };
const assistant = {
  id: "assistant",
  type: "ai",
  content: "Hello duaa!",
};
const toolMessage = {
  id: "old-result",
  type: "tool",
  tool_call_id: "call",
  content: '{"a2ui_operations": []}',
};
const finalValues = { messages: [human, toolMessage, assistant] };
const state: ThreadState<State> = {
  values: finalValues,
  next: [],
  tasks: [],
  metadata: {},
  checkpoint: {
    checkpoint_id: "checkpoint",
    checkpoint_ns: "",
    thread_id: "thread",
    checkpoint_map: {},
  },
  created_at: null,
  parent_checkpoint: null,
};

function event(
  method: string,
  data: object,
  namespace: string[] = [],
): ProtocolEvent {
  return {
    type: "event",
    seq: 0,
    method,
    params: { namespace, timestamp: 0, data },
  };
}

async function run(
  chunks: ProtocolEvent[],
  historical = false,
  messages: Message[] = [],
) {
  const agent = new LangGraphAgent({
    graphId: "agentic_chat",
    deploymentUrl: "http://localhost:2024",
  });
  vi.spyOn(agent.client.threads, "getState").mockResolvedValue(state);
  const streamResponse = new SubscriptionHandle<never, ProtocolEvent>(
    "test",
    { channels: [] },
    async () => {},
  );
  vi.spyOn(streamResponse, Symbol.asyncIterator).mockImplementation(
    async function* () {
      yield* chunks;
    },
  );
  const emitted: ProcessedEvents[] = [];
  agent.dispatchEvent = (e) => {
    emitted.push(e);
    return true;
  };
  agent.activeRun = {
    id: "server-run",
    threadId: "thread",
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  const error = vi.fn();
  await agent.handleStreamEventsV3(
    {
      streamResponse: (async function* () {
        yield* streamResponse;
      })(),
      state: { ...state, values: historical ? finalValues : {} },
      terminal: {},
      close: () => {},
    },
    "thread",
    new Subscriber<ProcessedEvents>({
      error,
      next: () => {},
      complete: () => {},
    }),
    {
      runId: "run",
      threadId: "thread",
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: { nodeName: "chat" },
    },
    [],
  );
  expect(error).not.toHaveBeenCalled();
  return emitted.filter((e) => e.type !== EventType.RAW);
}

const results = (events: ProcessedEvents[]) =>
  events.filter((e) => e.type === EventType.TOOL_CALL_RESULT);
const live = event("tools", {
  event: "tool-finished",
  tool_call_id: "call",
  output: toolMessage,
});
describe("raw V3 tool results without task or tools channels", () => {
  it("emits the ToolMessage content from root values before finishing", async () => {
    const events = await run([event("values", finalValues)]);
    expect(results(events)).toEqual([
      expect.objectContaining({
        toolCallId: "call",
        content: toolMessage.content,
        role: "tool",
      }),
    ]);
    expect(
      events.findIndex((e) => e.type === EventType.TOOL_CALL_RESULT),
    ).toBeLessThan(events.findIndex((e) => e.type === EventType.RUN_FINISHED));
  });
  it.each([false, true])(
    "deduplicates repeated values and live tools in either order (%s)",
    async (toolsFirst) => {
      const values = event("values", finalValues);
      const events = await run(
        toolsFirst ? [live, values, values] : [values, values, live],
      );
      expect(results(events)).toHaveLength(1);
    },
  );
  it("recovers a final-state-only tool result", async () => {
    expect(results(await run([]))).toHaveLength(1);
  });
  it("does not replay historical thread results", async () => {
    expect(
      results(await run([event("values", finalValues), live], true)),
    ).toEqual([]);
  });
  it("ignores nested values before the authoritative root state", async () => {
    const events = await run([
      event(
        "values",
        { messages: [{ ...toolMessage, tool_call_id: "nested" }] },
        ["child"],
      ),
    ]);
    expect(results(events)).toEqual([
      expect.objectContaining({ toolCallId: "call" }),
    ]);
  });
});

it("does not replay tool results supplied in input messages", async () => {
  expect(
    results(
      await run([event("values", finalValues)], false, [
        {
          id: "old",
          role: "tool",
          toolCallId: "call",
          content: toolMessage.content,
        },
      ]),
    ),
  ).toEqual([]);
});
it("leaves transformer-owned results untouched", async () => {
  expect(
    results(
      await run([
        event("agui", { type: EventType.STATE_SNAPSHOT, snapshot: {} }),
        event("values", finalValues),
      ]),
    ),
  ).toEqual([]);
});
it("does not emit final-state results after a terminal failure", async () => {
  const events = await run([
    event("lifecycle", { event: "failed", error: "failed" }),
  ]);
  expect(results(events)).toEqual([]);
});

it("allows a fresh invocation to reuse a historical call ID without replaying stale values", async () => {
  const fresh = { ...toolMessage, id: "new-result", content: "new output" };
  const events = await run(
    [
      event("messages", { event: "message-start", id: "new-assistant" }),
      event("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "tool_call", id: "call", name: "search", args: {} },
      }),
      event("messages", { event: "content-block-finish", index: 0 }),
      event("messages", { event: "message-finish" }),
      event("values", finalValues),
      event("values", { messages: [toolMessage, fresh] }),
      event("tools", {
        event: "tool-finished",
        tool_call_id: "call",
        output: fresh,
      }),
    ],
    true,
  );
  expect(results(events)).toEqual([
    expect.objectContaining({ toolCallId: "call", content: "new output" }),
  ]);
});
