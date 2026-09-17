import { EventType, type BaseEvent } from "@ag-ui/core";
// @langchain/langgraph-sdk is a graph persistence client, not an LLM provider;
// aimock does not apply to these synthetic stream-reader tests.
import type {
  Assistant,
  EventsStreamEvent,
  ThreadState,
} from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";

const AGUI_RUN_ID = "agui-run-1";
const SERVER_RUN_ID = "platform-run-9f2c";

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

function createAgent() {
  return new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
}

function threadState(): ThreadState {
  return {
    values: { messages: [] },
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

// A chunk carrying the run id LangGraph Platform assigned, which is always a
// different value from the AG-UI run id the caller passed in.
function serverRunIdChunk(): EventsStreamEvent {
  return {
    event: "events",
    data: {
      event: "on_chain_start",
      name: "test event",
      tags: [],
      run_id: SERVER_RUN_ID,
      metadata: { langgraph_node: "agent", run_id: SERVER_RUN_ID },
      parent_ids: [],
      data: {},
    },
  };
}

function runIdOf(event: BaseEvent): string | undefined {
  return (event as { runId?: string }).runId;
}

describe("run identity against a platform-assigned run id", () => {
  it("keeps the caller's run id on RUN_STARTED and RUN_FINISHED", async () => {
    const agent = createAgent();
    const state = threadState();
    vi.spyOn(agent.client.threads, "getState").mockResolvedValue(state);

    async function* streamResponse(): AsyncGenerator<EventsStreamEvent> {
      yield serverRunIdChunk();
    }
    agent.assistant = TEST_ASSISTANT;
    vi.spyOn(agent, "prepareStream").mockResolvedValue({
      streamResponse: streamResponse(),
      state,
    });

    const events: ProcessedEvents[] = [];
    await new Promise<void>((resolve, reject) => {
      agent
        .run({
          threadId: "thread-1",
          runId: AGUI_RUN_ID,
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });

    const started = events.filter((e) => e.type === EventType.RUN_STARTED);
    const finished = events.filter((e) => e.type === EventType.RUN_FINISHED);
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(started.map(runIdOf)).toEqual([AGUI_RUN_ID]);
    // A RUN_FINISHED naming the platform id would close a run the consumer
    // never saw opened, and the client rejects the stream.
    expect(finished.map(runIdOf)).toEqual([AGUI_RUN_ID]);
  });

  it("cancels on the platform with the server-assigned run id", async () => {
    const agent = createAgent();
    const state = threadState();
    vi.spyOn(agent.client.threads, "getState").mockResolvedValue(state);
    const cancel = vi
      .spyOn(agent.client.runs, "cancel")
      .mockResolvedValue(undefined as never);

    const streamError = new Error("stop after cancellation");
    async function* streamResponse(): AsyncGenerator<EventsStreamEvent> {
      yield serverRunIdChunk();
      // Resuming the generator means the chunk above was fully processed, so
      // the server run id is known by now.
      agent.abortRun();
      throw streamError;
    }
    agent.assistant = TEST_ASSISTANT;
    vi.spyOn(agent, "prepareStream").mockResolvedValue({
      streamResponse: streamResponse(),
      state,
    });

    await new Promise<void>((resolve, reject) => {
      agent
        .run({
          threadId: "thread-1",
          runId: AGUI_RUN_ID,
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({
          next: () => {},
          error: (error) => (error === streamError ? resolve() : reject(error)),
          complete: resolve,
        });
    });

    expect(cancel).toHaveBeenCalledWith("thread-1", SERVER_RUN_ID);
  });
});
