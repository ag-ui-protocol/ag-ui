import { EventType } from "@ag-ui/core";
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
const initialValues = { messages: [human], copilotkit: { actions: [] } };
const finalValues = { ...initialValues, messages: [human, assistant] };
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

function task(
  name: string,
  phase: "input" | "result",
  id = name,
  namespace: string[] = [],
) {
  return event("tasks", { id, name, [phase]: {}, interrupts: [] }, namespace);
}

async function run(
  chunks: ProtocolEvent[],
  schemaKeys?: { output: string[] },
  checkpoints: Record<string, State> = {},
  expectedError?: string,
) {
  const agent = new LangGraphAgent({
    graphId: "agentic_chat",
    deploymentUrl: "http://localhost:2024",
  });
  vi.spyOn(agent.client.threads, "getState").mockImplementation(
    async (_thread, checkpoint) => {
      if (typeof checkpoint === "string") {
        const values = checkpoints[checkpoint];
        if (!values) throw new Error(`Unexpected checkpoint ${checkpoint}`);
        return { ...state, values };
      }
      return state;
    },
  );
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
    schemaKeys: schemaKeys
      ? { input: null, config: null, context: null, ...schemaKeys }
      : undefined,
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  const error = vi.fn();
  await agent.handleStreamEventsV3(
    {
      streamResponse,
      state: { ...state, values: {} },
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
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
    [],
  );
  if (expectedError)
    expect(error).toHaveBeenCalledWith(new Error(expectedError));
  else expect(error).not.toHaveBeenCalled();
  return emitted.filter((e) => e.type !== EventType.RAW);
}

function steps(events: ProcessedEvents[]) {
  return events.filter(
    (e) =>
      e.type === EventType.STEP_STARTED || e.type === EventType.STEP_FINISHED,
  );
}

describe("raw V3 task steps and initial state", () => {
  it("emits real middleware steps and initial state in the greeting journey", async () => {
    const emitted = await run([
      event("lifecycle", { event: "running", graph_name: "agentic_chat" }),
      event("values", initialValues),
      task("CopilotKitMiddleware.before_agent", "input"),
      task("CopilotKitMiddleware.before_agent", "result"),
      event("values", initialValues),
      task("model_request", "input"),
      event("lifecycle", { event: "started", graph_name: "model_request" }, [
        "model_request:task",
      ]),
      event("messages", { event: "message-start", id: "assistant" }, [
        "model_request:task",
      ]),
      event(
        "messages",
        {
          event: "content-block-start",
          index: 0,
          content: { type: "text", text: "" },
        },
        ["model_request:task"],
      ),
      event(
        "messages",
        {
          event: "content-block-delta",
          index: 0,
          delta: { type: "text-delta", text: "Hello duaa!" },
        },
        ["model_request:task"],
      ),
      event("messages", { event: "message-finish" }, ["model_request:task"]),
      event("tasks", {
        id: "model_request",
        name: "model_request",
        result: { messages: [assistant] },
        interrupts: [],
      }),
      event("lifecycle", { event: "completed", graph_name: "model_request" }, [
        "model_request:task",
      ]),
      event("values", finalValues),
      task("CopilotKitMiddleware.after_model", "input"),
      task("CopilotKitMiddleware.after_model", "result"),
      task("CopilotKitMiddleware.after_agent", "input"),
      task("CopilotKitMiddleware.after_agent", "result"),
      event("lifecycle", { event: "completed", graph_name: "agentic_chat" }),
    ]);
    expect(
      emitted.map((e) =>
        "stepName" in e ? `${e.type}:${e.stepName}` : e.type,
      ),
    ).toEqual([
      "RUN_STARTED",
      "STEP_STARTED:CopilotKitMiddleware.before_agent",
      "STATE_SNAPSHOT",
      "STEP_FINISHED:CopilotKitMiddleware.before_agent",
      "STEP_STARTED:model_request",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "STATE_SNAPSHOT",
      "STEP_FINISHED:model_request",
      "STEP_STARTED:CopilotKitMiddleware.after_model",
      "STATE_SNAPSHOT",
      "STEP_FINISHED:CopilotKitMiddleware.after_model",
      "STEP_STARTED:CopilotKitMiddleware.after_agent",
      "STEP_FINISHED:CopilotKitMiddleware.after_agent",
      "STATE_SNAPSHOT",
      "MESSAGES_SNAPSHOT",
      "RUN_FINISHED",
    ]);
    expect(
      emitted
        .filter((e) => e.type === EventType.STATE_SNAPSHOT)
        .map((e) => e.snapshot),
    ).toEqual([
      initialValues,
      { ...initialValues, messages: [assistant] },
      finalValues,
      finalValues,
    ]);
    expect(emitted[0]).toMatchObject({ runId: "run" });
  });

  it("hydrates partial task output and node-entry state from their exact checkpoints", async () => {
    const action = {
      type: "function",
      name: "change_background",
      function: {
        name: "change_background",
        parameters: {
          type: "object",
          properties: { color: { type: "string" } },
        },
      },
    };
    const before = { ...initialValues, copilotkit: { actions: [action] } };
    const after = {
      ...before,
      messages: [
        human,
        { ...assistant, response_metadata: { provider_field: "preserved" } },
      ],
    };
    const lossyActions = {
      copilotkit: {
        actions: [{ type: "function", name: "change_background", content: "" }],
      },
    };
    const emitted = await run(
      [
        event("checkpoints", { id: "before", step: 0 }),
        event("values", { ...before, ...lossyActions }),
        task("model_request", "input"),
        event("tasks", {
          id: "model_request",
          result: { messages: [assistant] },
        }),
        event("checkpoints", { id: "after", step: 1 }),
        event("values", { ...finalValues, ...lossyActions }),
        task("after_model", "input"),
        task("after_model", "result"),
      ],
      undefined,
      { before, after },
    );
    const snapshots = emitted.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );
    expect(snapshots.slice(0, 3).map((e) => e.snapshot)).toEqual([
      before,
      { ...before, messages: [after.messages[1]] },
      after,
    ]);
    expect(emitted.findIndex((e) => e === snapshots[1])).toBeLessThan(
      emitted.findIndex(
        (e) =>
          e.type === EventType.STEP_FINISHED && e.stepName === "model_request",
      ),
    );
  });

  it("does not substitute latest state when a boundary checkpoint cannot be read", async () => {
    const emitted = await run(
      [event("checkpoints", { id: "missing", step: 0 })],
      undefined,
      {},
      "Unexpected checkpoint missing",
    );
    expect(emitted.map((e) => e.type)).toEqual([EventType.RUN_STARTED]);
  });

  it("keeps completion order when concurrent results wait for a checkpoint", async () => {
    const emitted = await run(
      [
        event("checkpoints", { id: "before", step: 0 }),
        task("left", "input"),
        task("right", "input"),
        event("tasks", { id: "left", result: { messages: [assistant] } }),
        task("right", "result"),
        event("checkpoints", { id: "after", step: 1 }),
      ],
      undefined,
      { before: initialValues, after: finalValues },
    );
    expect(
      steps(emitted)
        .filter((e) => e.type === EventType.STEP_FINISHED)
        .map((e) => e.stepName),
    ).toEqual(["left", "right"]);
  });

  it("attributes native V3 terminal usage to the same provider and model as V2", async () => {
    const emitted = await run([
      event("messages", { event: "message-start", id: "assistant" }),
      event("messages", {
        event: "message-finish",
        usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
        responseMetadata: { model_provider: "openai", model_name: "gpt-4o" },
      }),
    ]);
    expect(emitted.at(-1)).toMatchObject({
      usage: [
        {
          provider: "openai",
          model: "gpt-4o",
          inputTokens: 11,
          outputTokens: 10,
          totalTokens: 21,
        },
      ],
    });
  });

  it("balances overlapping tasks by identity and ignores nested task duplicates", async () => {
    const emitted = await run([
      task("left", "input"),
      task("right", "input"),
      task("left", "input"),
      task("inner", "input", "nested", ["left:task"]),
      task("inner", "result", "nested", ["left:task"]),
      task("left", "result"),
      task("right", "result"),
      task("left", "result"),
    ]);
    expect(steps(emitted)).toEqual([
      { type: EventType.STEP_STARTED, stepName: "left" },
      { type: EventType.STEP_STARTED, stepName: "right" },
      { type: EventType.STEP_FINISHED, stepName: "left" },
      { type: EventType.STEP_FINISHED, stepName: "right" },
    ]);
  });

  it("keeps a shared step name open until every task with that name finishes", async () => {
    const emitted = await run([
      task("worker", "input", "first"),
      task("worker", "input", "second"),
      task("worker", "result", "first"),
      event("custom", { name: "still-working", payload: null }),
      task("worker", "result", "second"),
    ]);
    expect(
      emitted.filter((e) => e.type === EventType.CUSTOM || "stepName" in e),
    ).toEqual([
      { type: EventType.STEP_STARTED, stepName: "worker" },
      { type: EventType.CUSTOM, name: "still-working", value: null },
      { type: EventType.STEP_FINISHED, stepName: "worker" },
    ]);
  });

  it("filters the initial snapshot through the output schema and never uses nested values", async () => {
    const emitted = await run(
      [
        event("values", { messages: [] }),
        event("values", { messages: [], secret: "nested" }, ["nested:task"]),
        event("values", { ...initialValues, visible: 1, secret: "internal" }),
        task("chat", "input"),
        task("chat", "result"),
      ],
      { output: ["visible"] },
    );
    expect(emitted.find((e) => e.type === EventType.STATE_SNAPSHOT)).toEqual({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { messages: [human], visible: 1 },
    });
  });

  it("closes a failed task before the run error without a duplicate finish", async () => {
    const emitted = await run([
      task("model_request", "input"),
      event("tasks", { id: "model_request", error: "model failed" }),
      event("error", { message: "model failed" }),
    ]);
    expect(emitted.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STEP_STARTED,
      EventType.STEP_FINISHED,
      EventType.RUN_ERROR,
    ]);
  });

  it.each(["failed", "completed"])(
    "closes unfinished tasks before root %s",
    async (status) => {
      const emitted = await run([
        task("model_request", "input"),
        event("lifecycle", {
          event: status,
          graph_name: "agentic_chat",
          error: "model failed",
        }),
      ]);
      expect(steps(emitted)).toEqual([
        { type: EventType.STEP_STARTED, stepName: "model_request" },
        { type: EventType.STEP_FINISHED, stepName: "model_request" },
      ]);
      expect(emitted.at(-1)?.type).toBe(
        status === "failed" ? EventType.RUN_ERROR : EventType.RUN_FINISHED,
      );
    },
  );

  it("leaves transformer passthrough in charge of steps and snapshots", async () => {
    const transformerStart = {
      type: EventType.STEP_STARTED,
      stepName: "transformer_step",
    };
    const transformerFinish = {
      type: EventType.STEP_FINISHED,
      stepName: "transformer_step",
    };
    const emitted = await run([
      event("custom:agui", transformerStart),
      event("checkpoints", { id: "transformer-owned", step: 0 }),
      event("values", initialValues),
      task("raw_task", "input"),
      task("raw_task", "result"),
      event("custom:agui", transformerFinish),
      event("custom:agui", {
        type: EventType.STATE_SNAPSHOT,
        snapshot: initialValues,
      }),
      event("custom:agui", { type: EventType.MESSAGES_SNAPSHOT, messages: [] }),
    ]);
    expect(steps(emitted)).toEqual([transformerStart, transformerFinish]);
    expect(
      emitted
        .filter((e) => e.type === EventType.STATE_SNAPSHOT)
        .map((e) => e.snapshot),
    ).toEqual([initialValues]);
    expect(
      emitted.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT),
    ).toEqual([{ type: EventType.MESSAGES_SNAPSHOT, messages: [] }]);
  });
});
