import type {
  Assistant,
  EventsStreamEvent,
  ThreadState,
} from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";
import { LangGraphAgent, type ProcessedEvents } from "./agent";

// The AG-UI run id the caller generates. LangGraph has never seen it, so a
// cancel addressed to it is rejected.
const CLIENT_RUN_ID = "client-run-1";
// The id LangGraph assigns, first visible on a chunk's metadata.run_id.
const SERVER_RUN_ID = "server-run-1";
const THREAD_ID = "thread-1";

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

function threadState(): ThreadState {
  return {
    values: { messages: [] },
    next: [],
    checkpoint: {
      thread_id: THREAD_ID,
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
  metadata: EventsStreamEvent["data"]["metadata"],
): EventsStreamEvent {
  return {
    event: "events",
    data: {
      event: "on_chat_model_stream",
      name: "test event",
      tags: [],
      run_id: SERVER_RUN_ID,
      metadata,
      parent_ids: [],
      data: { chunk: { content: "", response_metadata: {} } },
    },
  };
}

/**
 * A cancel endpoint that behaves like LangGraph: it only knows the run id it
 * assigned itself, and 404s on anything else.
 *
 * `accepted` records only the calls LangGraph actually honoured. A rejected
 * promise still counts as a "return" in vitest's mock results, so asserting on
 * mock results instead of this array would pass even when every cancel 404d.
 */
function cancelSpy() {
  const accepted: string[] = [];
  const fn = vi.fn(async (_threadId: string, runId: string) => {
    if (runId !== SERVER_RUN_ID) {
      throw new Error(`404: no run ${runId}`);
    }
    accepted.push(runId);
  });
  return Object.assign(fn, { accepted });
}

function createAgent(cancel: ReturnType<typeof cancelSpy>) {
  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
  agent.assistant = TEST_ASSISTANT;
  (agent as any).client = { runs: { cancel } };
  return agent;
}

async function settle(
  agent: LangGraphAgent,
  chunks: () => AsyncGenerator<EventsStreamEvent>,
) {
  vi.spyOn(agent, "prepareStream").mockResolvedValue({
    streamResponse: chunks(),
    state: threadState(),
  } as any);

  const events: ProcessedEvents[] = [];
  await new Promise<void>((resolve) => {
    agent
      .run({
        threadId: THREAD_ID,
        runId: CLIENT_RUN_ID,
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .subscribe({
        next: (event) => events.push(event),
        // Either terminal outcome is fine; the assertions are about which
        // cancels reached LangGraph, not about how the stream ended.
        error: () => resolve(),
        complete: () => resolve(),
      });
  });
  return events;
}

describe("abortRun races", () => {
  it("retries the cancel with the server run id after the first one 404s", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    async function* chunks() {
      // The stop lands while the first chunk is in flight, before any chunk
      // has carried metadata.run_id. activeRun.id is still CLIENT_RUN_ID.
      agent.abortRun();
      yield eventChunk({ langgraph_node: "agent" });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
    }

    await settle(agent, chunks);

    const cancelledIds = cancel.mock.calls.map(([, runId]) => runId);
    expect(cancelledIds).toContain(SERVER_RUN_ID);
  });

  it("does not report a stop it never delivered to LangGraph", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    async function* chunks() {
      agent.abortRun();
      yield eventChunk({ langgraph_node: "agent" });
      yield eventChunk({ langgraph_node: "agent" });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
    }

    await settle(agent, chunks);

    // The agent may only consider the stop delivered once LangGraph accepted
    // one. Marking it delivered off the back of a 404 is the defect: the run
    // then keeps going server-side while the caller is told it stopped.
    if ((agent as any).cancelSent) {
      expect(cancel.accepted).not.toEqual([]);
    }
  });

  it("does not retry the cancel until LangGraph's own run id is known", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    async function* chunks() {
      agent.abortRun();
      // Six chunks before the stream ever reports metadata.run_id. A cancel
      // addressed to the client id 404s every time, so retrying per chunk is a
      // burst of requests that cannot succeed.
      for (let i = 0; i < 6; i++) {
        yield eventChunk({ langgraph_node: "agent" });
      }
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
    }

    await settle(agent, chunks);

    const doomed = cancel.mock.calls.filter(
      ([, runId]) => runId !== SERVER_RUN_ID,
    );
    // At most the single attempt abortRun() itself makes, never one per chunk.
    expect(doomed.length).toBeLessThanOrEqual(1);
    expect(cancel.accepted).toContain(SERVER_RUN_ID);
  });

  it("does not carry a pre-stream stop into the next run", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);
    agent.threadId = THREAD_ID;

    // First run: stopped before the stream opens, then it fails before
    // runAgentStream is ever reached, so nothing consumes the pending stop.
    const failing = vi
      .spyOn(agent as any, "onInitialize")
      .mockImplementation(async () => {
        agent.abortRun();
        throw new Error("initialization failed");
      });
    await agent.runAgent({ runId: "client-run-doomed" }).catch(() => {});
    failing.mockRestore();

    // Second run: a fresh, un-stopped run. It must stream normally.
    async function* chunks() {
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
    }
    vi.spyOn(agent, "prepareStream").mockResolvedValue({
      streamResponse: chunks(),
      state: threadState(),
    } as any);

    await agent.runAgent({ runId: CLIENT_RUN_ID }).catch(() => {});

    expect((agent as any).cancelRequested).toBe(false);
    expect(cancel.accepted).toEqual([]);
  });

  it("keeps a stop that arrives before the LangGraph stream opens", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    // runAgent sets isRunning, then awaits onInitialize, and only afterwards
    // reaches runAgentStream. A stop in that window has no activeRun to cancel
    // and no stream loop to observe it.
    vi.spyOn(agent as any, "onInitialize").mockImplementation(async () => {
      agent.abortRun();
    });

    async function* chunks() {
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
    }
    vi.spyOn(agent, "prepareStream").mockResolvedValue({
      streamResponse: chunks(),
      state: threadState(),
    } as any);

    agent.threadId = THREAD_ID;
    await agent
      .runAgent({ runId: CLIENT_RUN_ID, forwardedProps: {} })
      .catch(() => {});

    const cancelledIds = cancel.mock.calls.map(([, runId]) => runId);
    expect(cancelledIds).toContain(SERVER_RUN_ID);
  });
});
