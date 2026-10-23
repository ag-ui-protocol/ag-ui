/**
 * Pins the STATE_SNAPSHOT emission cost of a run (#2600).
 *
 * The adapter used to ship the entire graph state on every stream chunk once
 * any node had exited, so the stream grew as O(state size x chunk count). These
 * tests measure the actual emitted STATE_SNAPSHOT events across a realistic
 * multi-node, multi-chunk run rather than asserting on internal flags.
 */
import { EventType, type StateSnapshotEvent } from "@ag-ui/core";
import type {
  Assistant,
  EventsStreamEvent,
  ThreadState,
} from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import { CustomEventNames } from "./types";

const TEST_ASSISTANT: Assistant = {
  assistant_id: "assistant-1",
  graph_id: "test-graph",
  config: {},
  context: {},
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  metadata: {},
  version: 1,
  name: "test assistant",
};

function threadState(values: ThreadState["values"]): ThreadState {
  return {
    values,
    next: [],
    checkpoint: {
      thread_id: "thread-1",
      checkpoint_ns: "",
      checkpoint_id: null,
      checkpoint_map: null,
    },
    metadata: {},
    created_at: null,
    parent_checkpoint: null,
    tasks: [],
  };
}

function eventChunk(
  event: string,
  node: string,
  data: EventsStreamEvent["data"]["data"],
): EventsStreamEvent {
  return {
    event: "events",
    data: {
      event,
      name: node,
      tags: ["graph:step:1"],
      run_id: `${node}-run-1`,
      metadata: { langgraph_node: node, langgraph_step: 1 },
      parent_ids: [],
      data,
    },
  };
}

/** A chunk that carries no state change at all — pure stream noise. */
function idleChunk(node: string): EventsStreamEvent {
  return eventChunk("on_chain_stream", node, { chunk: {} });
}

/** A node completing with a state update. */
function nodeEnd(node: string, output: unknown) {
  return eventChunk("on_chain_end", node, { output });
}

function nodeStart(node: string) {
  return eventChunk("on_chain_start", node, { input: {} });
}

/** A reduced-state pulse from `values` mode, mid-node. */
function valuesChunk(values: Record<string, unknown>): any {
  return { event: "values", data: values };
}

async function runStream(
  chunks: any[],
  initial: ThreadState,
  finalState?: ThreadState,
) {
  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
  const streamError = new Error("stop after inspected chunk");
  async function* streamResponse() {
    yield* chunks;
    if (!finalState) throw streamError;
  }
  agent.assistant = TEST_ASSISTANT;
  if (finalState) {
    vi.spyOn(agent.client.threads, "getState").mockResolvedValue(finalState);
  }
  vi.spyOn(agent, "prepareStream").mockResolvedValue({
    streamResponse: streamResponse() as any,
    state: initial,
  } as any);

  const events: ProcessedEvents[] = [];
  await new Promise<void>((resolve, reject) => {
    agent
      .run({
        threadId: "thread-1",
        runId: "run-1",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (e) => events.push(structuredClone(e)),
        error: reject,
        complete: resolve,
      });
  });
  expect(
    events.filter(
      (e) =>
        e.type === EventType.RUN_ERROR || e.type === EventType.RUN_FINISHED,
    ),
  ).toEqual([
    finalState
      ? { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" }
      : { type: EventType.RUN_ERROR, message: streamError.message },
  ]);
  return events;
}

function snapshots(events: ProcessedEvents[]): StateSnapshotEvent[] {
  return events.filter(
    (e): e is StateSnapshotEvent => e.type === EventType.STATE_SNAPSHOT,
  );
}

/**
 * A two-node run: node "research" completes with a state update, then node
 * "respond" produces `idle` chunks that change nothing before completing.
 */
function twoNodeRun(idle: number, payload: string): EventsStreamEvent[] {
  return [
    nodeStart("research"),
    ...Array.from({ length: idle }, () => idleChunk("research")),
    nodeEnd("research", { report: payload }),
    nodeStart("respond"),
    ...Array.from({ length: idle }, () => idleChunk("respond")),
    nodeEnd("respond", { report: payload, answer: "done" }),
    ...Array.from({ length: idle }, () => idleChunk("respond")),
  ];
}

describe("STATE_SNAPSHOT emission cost (#2600)", () => {
  it("does not grow the snapshot count with the number of idle chunks", async () => {
    const initial = threadState({ messages: [] });
    const few = snapshots(await runStream(twoNodeRun(3, "x"), initial));
    const many = snapshots(await runStream(twoNodeRun(40, "x"), initial));

    expect(many.length).toBe(few.length);
  });

  it("does not re-ship an unchanged state payload once a node has exited", async () => {
    const payload = "P".repeat(4096);
    const events = await runStream(
      twoNodeRun(20, payload),
      threadState({ messages: [] }),
    );
    const copies = snapshots(events).filter((e) =>
      JSON.stringify(e.snapshot).includes(payload),
    ).length;

    // The payload enters state once at the "research" boundary and is still
    // there at the "respond" boundary, so at most a handful of copies are
    // legitimate. Anything proportional to the 20 idle chunks is amplification.
    expect(copies).toBeLessThanOrEqual(4);
  });

  it("emits a snapshot when state changes mid-node, with no node transition", async () => {
    // `values` pulses carry reduced state between node boundaries. The
    // following chunk is the first chance to ship them, and it is neither a
    // node change nor a node exit — only a real state diff can emit it.
    const events = await runStream(
      [
        nodeStart("research"),
        nodeEnd("research", { step: "research-done" }),
        nodeStart("respond"),
        valuesChunk({ step: "research-done", progress: "half" }),
        idleChunk("respond"),
        valuesChunk({ step: "research-done", progress: "full" }),
        idleChunk("respond"),
      ],
      threadState({ messages: [] }),
    );
    const seen = snapshots(events).map((e) => JSON.stringify(e.snapshot));

    expect(seen.some((s) => s.includes("half"))).toBe(true);
    expect(seen.some((s) => s.includes("full"))).toBe(true);
  });

  it("still emits a snapshot at each node boundary that changes state", async () => {
    const events = await runStream(
      twoNodeRun(2, "report-body"),
      threadState({ messages: [] }),
    );
    const seen = snapshots(events).map((e) => JSON.stringify(e.snapshot));

    expect(seen.some((s) => s.includes("report-body"))).toBe(true);
    expect(seen.some((s) => s.includes("done"))).toBe(true);
  });
});

function customChunk(
  node: string,
  name: string,
  data: Record<string, unknown>,
) {
  const chunk = eventChunk("on_custom_event", node, data);
  chunk.data.name = name;
  return chunk;
}

const seededState = { messages: [], phase: "seeded", count: 1 };
const manualState = {
  ...seededState,
  phase: "manual",
  manualOnly: "kept",
};
const completedState = {
  ...manualState,
  phase: "body-done",
  count: 2,
};

function manualRunPrefix(manual = manualState) {
  return [
    nodeStart("pre"),
    nodeEnd("pre", seededState),
    nodeStart("body"),
    customChunk("body", CustomEventNames.ManuallyEmitState, manual),
    // Ensure manual state is observed on a separate chunk before completion.
    idleChunk("body"),
  ];
}

describe("manual state reconciliation at node completion", () => {
  for (const internalName of ["RunnableLambda", "body"]) {
    it(`keeps manual state authoritative when an internal ${internalName} completes before the node fails`, async () => {
      const manual = { ...manualState, count: 10 };
      const internalStart = nodeStart("body");
      const internalEnd = nodeEnd("body", {
        phase: "inner-result",
        count: 999,
      });
      for (const chunk of [internalStart, internalEnd]) {
        chunk.data.name = internalName;
        chunk.data.run_id = "internal-run-1";
        // graph:step is local to the node callback, not inherited by children.
        chunk.data.tags = [];
      }
      const events = await runStream(
        [
          ...manualRunPrefix(manual),
          internalStart,
          internalEnd,
          idleChunk("body"),
        ],
        threadState({ messages: [] }),
      );
      const states = snapshots(events).map((e) => e.snapshot);
      expect(states.some((s) => s.phase === "inner-result")).toBe(false);
      expect(states.at(-1)).toEqual(manual);
    });
  }

  for (const [kind, output] of [
    ["partial dictionary", { phase: "body-done", count: 2 }],
    [
      "Command update",
      [{ lg_name: "Command", update: { phase: "body-done", count: 2 } }],
    ],
  ] as const) {
    for (const succeeds of [false, true]) {
      it(`delivers newer ${kind} before the following node ${succeeds ? "succeeds" : "fails"}`, async () => {
        const finalState = threadState({
          ...completedState,
          phase: "finished",
        });
        const events = await runStream(
          [
            ...manualRunPrefix(),
            nodeEnd("body", output),
            nodeStart("finish"),
            ...(succeeds ? [nodeEnd("finish", finalState.values)] : []),
          ],
          threadState({ messages: [] }),
          succeeds ? finalState : undefined,
        );
        const finishStart = events.findIndex(
          (e) => e.type === EventType.STEP_STARTED && e.stepName === "finish",
        );
        expect(finishStart).toBeGreaterThanOrEqual(0);
        const beforeFinish = snapshots(events.slice(0, finishStart));
        expect(beforeFinish.at(-1)?.snapshot).toEqual(completedState);
        // A later error cannot repair stale state through a terminal checkpoint.
        const afterCompletion = snapshots(events.slice(finishStart));
        expect(afterCompletion.every((e) => e.snapshot.count !== 1)).toBe(true);
        if (succeeds) {
          expect(snapshots(events).at(-1)?.snapshot).toEqual(finalState.values);
        }
      });
    }
  }

  it("preserves manual-only keys when the completion output omits them", async () => {
    const events = await runStream(
      [...manualRunPrefix(), nodeEnd("body", { other: "new" })],
      threadState({ messages: [] }),
    );
    expect(snapshots(events).at(-1)?.snapshot).toEqual({
      ...manualState,
      other: "new",
    });
  });

  it("defers the fresh completion state until predictive streaming permits a snapshot", async () => {
    const prediction = eventChunk("on_chat_model_stream", "body", {
      chunk: {
        content: "",
        response_metadata: {},
        tool_call_chunks: [
          { name: "update_count", args: "", id: "call-1", index: 0 },
        ],
      },
    });
    prediction.data.metadata.predict_state = [
      { tool: "update_count", state_key: "count", tool_argument: "count" },
    ];
    const events = await runStream(
      [
        ...manualRunPrefix(),
        prediction,
        eventChunk("on_chat_model_end", "body", {}),
        nodeEnd("body", { phase: "body-done", count: 2 }),
        customChunk("body", "still-suppressed", {}),
        eventChunk("on_tool_end", "body", {
          output: {
            tool_call_id: "call-1",
            name: "update_count",
            content: "done",
          },
        }),
        idleChunk("body"),
        ...Array.from({ length: 5 }, () => idleChunk("body")),
      ],
      threadState({ messages: [] }),
    );
    const predictionIndex = events.findIndex(
      (e) => e.type === EventType.CUSTOM && e.name === "PredictState",
    );
    const toolResultIndex = events.findIndex(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    );
    expect(predictionIndex).toBeGreaterThanOrEqual(0);
    expect(toolResultIndex).toBeGreaterThan(predictionIndex);
    expect(
      snapshots(events.slice(predictionIndex, toolResultIndex)),
    ).toHaveLength(0);
    expect(
      snapshots(events.slice(toolResultIndex)).map((e) => e.snapshot),
    ).toEqual([completedState]);
  });
});
