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
      name: "test event",
      tags: [],
      run_id: "run-1",
      metadata: { langgraph_node: node },
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
function nodeEnd(node: string, output: Record<string, unknown>) {
  return eventChunk("on_chain_end", node, { output });
}

function nodeStart(node: string) {
  return eventChunk("on_chain_start", node, { input: {} });
}

/** A reduced-state pulse from `values` mode, mid-node. */
function valuesChunk(values: Record<string, unknown>): any {
  return { event: "values", data: values };
}

async function runStream(chunks: any[], initial: ThreadState) {
  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
  const streamError = new Error("stop after inspected chunk");
  async function* streamResponse() {
    yield* chunks;
    throw streamError;
  }
  agent.assistant = TEST_ASSISTANT;
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
        next: (e) => events.push(e),
        error: reject,
        complete: resolve,
      });
  });
  expect(
    events.filter(
      (e) =>
        e.type === EventType.RUN_ERROR || e.type === EventType.RUN_FINISHED,
    ),
  ).toEqual([{ type: EventType.RUN_ERROR, message: streamError.message }]);
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
