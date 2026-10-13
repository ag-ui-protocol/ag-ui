import { EventType } from "@ag-ui/core";
import type { ProtocolEvent } from "@langchain/langgraph";
import type { ThreadState } from "@langchain/langgraph-sdk";
import { firstValueFrom, Subscriber, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import type { State, V3MessageEvent } from "./types";

const state: ThreadState<State> = {
  values: {},
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
function message(
  runId: string,
  data: V3MessageEvent,
  namespace: string[] = [],
) {
  return {
    type: "event" as const,
    seq: 0,
    method: "messages",
    params: { namespace, timestamp: 0, data: { ...data, run_id: runId } },
  };
}
async function run(chunks: ProtocolEvent[], cancelAfterText = false) {
  const agent = new LangGraphAgent({
    graphId: "chat",
    deploymentUrl: "http://localhost:2024",
  });
  vi.spyOn(agent.client.threads, "getState").mockResolvedValue(state);
  const cancel = vi
    .spyOn(agent.client.runs, "cancel")
    .mockResolvedValue(undefined);
  agent.activeRun = {
    id: "graph-run",
    threadId: "thread",
    serverRunIdKnown: true,
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  const emitted: ProcessedEvents[] = [];
  agent.dispatchEvent = (event) => {
    emitted.push(event);
    if (cancelAfterText && event.type === EventType.TEXT_MESSAGE_CONTENT)
      agent.abortRun();
    return true;
  };
  const error = vi.fn();
  await agent.handleStreamEventsV3(
    {
      streamResponse: (async function* () {
        yield* chunks;
      })(),
      state: { ...state },
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
      runId: "graph-run",
      threadId: "thread",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: { nodeName: "chat" },
    },
    [],
  );
  expect(error).not.toHaveBeenCalled();
  return { emitted, cancel };
}
async function runCloned(
  original: LangGraphAgent,
  chunks: ProtocolEvent[],
  threadId: string,
) {
  const agent: LangGraphAgent = original.clone();
  vi.spyOn(agent, "getAssistant").mockResolvedValue({
    assistant_id: "assistant",
    graph_id: "chat",
    config: {},
    context: {},
    created_at: "",
    updated_at: "",
    metadata: {},
    version: 1,
    name: "chat",
  });
  vi.spyOn(agent.client.threads, "getState").mockResolvedValue(state);
  vi.spyOn(agent, "prepareStream").mockImplementation(async () => {
    if (!agent.activeRun)
      throw new Error("Run metadata must exist before preparation");
    agent.activeRun.isV3 = true;
    return {
      streamResponse: (async function* () {
        yield* chunks;
      })(),
      state: { ...state },
      terminal: {},
      close: () => {},
    };
  });
  return firstValueFrom(
    agent
      .run({
        runId: "graph-run",
        threadId,
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .pipe(toArray()),
  );
}
function textChunks(runId: string, id: string, namespace: string[] = []) {
  return [
    message(runId, { event: "message-start", id }, namespace),
    message(
      runId,
      { event: "content-block-start", index: 0, content: { type: "text" } },
      namespace,
    ),
    message(
      runId,
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: `${id}0` },
      },
      namespace,
    ),
    message(
      runId,
      {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: `${id}1` },
      },
      namespace,
    ),
    message(runId, { event: "message-finish" }, namespace),
  ];
}
describe("raw V3 model isolation", () => {
  it.each([false, true])(
    "runs V3 through a real clone (transformer=%s)",
    async (transformer) => {
      const original = new LangGraphAgent({
        graphId: "chat",
        deploymentUrl: "http://localhost:2024",
      });
      const chunks: ProtocolEvent[] = transformer
        ? [
            {
              type: "event",
              seq: 0,
              method: "agui",
              params: {
                namespace: [],
                timestamp: 0,
                data: { type: EventType.CUSTOM, name: "ready", value: true },
              },
            },
          ]
        : textChunks("model", "L");
      const events = await runCloned(original, chunks, "thread");
      expect(
        events.filter((event) => event.type === EventType.RUN_ERROR),
      ).toEqual([]);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      if (!transformer)
        expect(
          events
            .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
            .map((event) => event.delta)
            .join(""),
        ).toBe("L0L1");
    },
  );
  it("keeps concurrent clones of one agent isolated", async () => {
    const original = new LangGraphAgent({
      graphId: "chat",
      deploymentUrl: "http://localhost:2024",
    });
    const results = await Promise.all(
      ["L", "R"].map((id) =>
        runCloned(original, textChunks("same-model", id), id),
      ),
    );
    expect(
      results.map((events) =>
        events
          .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
          .map((event) => event.delta)
          .join(""),
      ),
    ).toEqual(["L0L1", "R0R1"]);
  });
  it.each([false, true])(
    "keeps interleaved model text and finishes separate (namespaced=%s)",
    async (namespaced) => {
      const left = textChunks("left-model", "L");
      const right = textChunks(
        namespaced ? "left-model" : "right-model",
        "R",
        namespaced ? ["child"] : [],
      );
      const { emitted } = await run([
        left[0]!,
        left[1]!,
        left[2]!,
        right[0]!,
        right[1]!,
        right[2]!,
        left[3]!,
        left[4]!,
        right[3]!,
        right[4]!,
      ]);
      const text = emitted.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
      );
      expect(
        text
          .filter((e) => e.messageId === "L")
          .map((e) => e.delta)
          .join(""),
      ).toBe("L0L1");
      expect(
        text
          .filter((e) => e.messageId === "R")
          .map((e) => e.delta)
          .join(""),
      ).toBe("R0R1");
      expect(
        emitted
          .filter((e) => e.type === EventType.TEXT_MESSAGE_END)
          .map((e) => e.messageId),
      ).toEqual(["L", "R"]);
    },
  );
  it("keeps reasoning, deferred tool arguments, and error cleanup scoped to their model", async () => {
    const { emitted } = await run([
      message("left", { event: "message-start", id: "L" }),
      message("right", { event: "message-start", id: "R" }),
      ...["left", "right"].flatMap((id) => [
        message(id, {
          event: "content-block-start",
          index: 0,
          content: { type: "reasoning" },
        }),
        message(id, {
          event: "content-block-start",
          index: 1,
          content: { type: "tool_call", id: `tool-${id}`, args: "{" },
        }),
      ]),
      message("left", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "reasoning-delta", reasoning: "think-left" },
      }),
      message("right", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "reasoning-delta", reasoning: "think-right" },
      }),
      message("left", {
        event: "content-block-delta",
        index: 1,
        delta: {
          type: "block-delta",
          fields: { name: "left-tool", args: "{}" },
        },
      }),
      message("left", { event: "message-error" }),
      message("right", {
        event: "content-block-delta",
        index: 1,
        delta: {
          type: "block-delta",
          fields: { name: "right-tool", args: "{}" },
        },
      }),
      message("right", { event: "message-finish" }),
    ]);
    expect(
      emitted.filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT),
    ).toMatchObject([
      { messageId: "L-reasoning-0", delta: "think-left" },
      { messageId: "R-reasoning-0", delta: "think-right" },
    ]);
    expect(
      emitted.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toMatchObject([
      {
        toolCallId: "tool-left",
        toolCallName: "left-tool",
        parentMessageId: "L",
      },
      {
        toolCallId: "tool-right",
        toolCallName: "right-tool",
        parentMessageId: "R",
      },
    ]);
    expect(
      emitted.filter((e) => e.type === EventType.TOOL_CALL_ARGS),
    ).toMatchObject([
      { toolCallId: "tool-left", delta: "{}" },
      { toolCallId: "tool-right", delta: "{}" },
    ]);
    expect(
      emitted
        .filter((e) => e.type === EventType.TOOL_CALL_END)
        .map((e) => e.toolCallId),
    ).toEqual(["tool-left", "tool-right"]);
  });
  it("assigns distinct IDs to concurrent tools without provider IDs", async () => {
    const { emitted } = await run([
      message("left", { event: "message-start", id: "L" }),
      message("right", { event: "message-start", id: "R" }),
      ...["left", "right"].map((id) =>
        message(id, {
          event: "content-block-start",
          index: 0,
          content: { type: "tool_call", name: id, args: "{}" },
        }),
      ),
      message("left", { event: "message-finish" }),
      message("right", { event: "message-finish" }),
    ]);
    const starts = emitted.filter((e) => e.type === EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((e) => e.toolCallId)).size).toBe(2);
    expect(starts.map((e) => e.parentMessageId)).toEqual(["L", "R"]);
  });
  it.each(["error", "lifecycle", "eof"])(
    "closes every model stream at %s",
    async (terminal) => {
      const terminalEvents: ProtocolEvent[] =
        terminal === "eof"
          ? []
          : [
              {
                type: "event",
                seq: 0,
                method: terminal,
                params: {
                  namespace: [],
                  timestamp: 0,
                  data:
                    terminal === "error"
                      ? { message: "boom" }
                      : { event: "failed", error: "boom" },
                },
              },
            ];
      const { emitted } = await run([
        ...textChunks("left", "L").slice(0, 3),
        ...textChunks("right", "R").slice(0, 3),
        ...terminalEvents,
      ]);
      expect(
        emitted
          .filter((e) => e.type === EventType.TEXT_MESSAGE_END)
          .map((e) => e.messageId),
      ).toEqual(["L", "R"]);
      const terminalIndex = emitted.findIndex(
        (e) =>
          e.type === EventType.RUN_ERROR || e.type === EventType.RUN_FINISHED,
      );
      expect(terminalIndex).toBeGreaterThan(
        emitted.map((e) => e.type).lastIndexOf(EventType.TEXT_MESSAGE_END),
      );
    },
  );
  it("preserves the submitted graph run ID through model text and completion", async () => {
    const { emitted } = await run(textChunks("model-run", "L"));
    expect(
      emitted.find((e) => e.type === EventType.RUN_FINISHED),
    ).toMatchObject({ runId: "graph-run" });
  });
  it("cancels the submitted graph run after receiving model text", async () => {
    const { cancel } = await run(textChunks("model-run", "L"), true);
    expect(cancel).toHaveBeenCalledWith("thread", "graph-run");
  });
});
