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

/**
 * The client is injected through `config.client` rather than written onto the
 * instance, so `clone()` carries the same stub instead of rebuilding a real
 * LangGraphClient that would reach the network.
 *
 * `threads.getState` is stubbed because the end of every stream calls it. Left
 * unmocked it throws, the agent reports the run as failed, and a test that
 * swallows run errors then asserts against a run that never really happened.
 */
function createAgent(cancel: ReturnType<typeof cancelSpy>) {
  const client = {
    runs: { cancel },
    threads: { getState: vi.fn(async () => threadState()) },
  };
  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client: client as never,
  });
  agent.assistant = TEST_ASSISTANT;
  agent.threadId = THREAD_ID;
  return agent;
}

/** Two chunks that both carry LangGraph's own run id. */
async function* serverIdentifiedChunks(): AsyncGenerator<EventsStreamEvent> {
  yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
  yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
}

function useStream(
  agent: LangGraphAgent,
  chunks: () => AsyncGenerator<EventsStreamEvent>,
) {
  vi.spyOn(agent, "prepareStream").mockResolvedValue({
    streamResponse: chunks(),
    state: threadState(),
  } as never);
}

/**
 * What a finished run must leave behind: no run in flight and no stop still
 * pending, so the next run starts from a clean slate. `cancelSent` is not
 * asserted anywhere — cleanup resets it, so reading it after a run says
 * nothing about whether the stop ever reached LangGraph. `cancel.accepted`
 * does.
 */
function expectSettled(agent: LangGraphAgent): void {
  expect((agent as any).isRunning).toBe(false);
  expect((agent as any).activeRun).toBeUndefined();
  expect((agent as any).cancelRequested).toBe(false);
  expect((agent as any).abortBeforeStreamOpen).toBe(false);
}

async function settle(
  agent: LangGraphAgent,
  chunks: () => AsyncGenerator<EventsStreamEvent>,
) {
  useStream(agent, chunks);

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

    expect(cancel.accepted).toContain(SERVER_RUN_ID);
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

  it("delivers a stop that lands once the stream is open, then runs again", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    async function* chunks() {
      // Stop window one: the run is streaming, but no chunk has carried
      // metadata.run_id yet, so LangGraph's own run id is not in hand.
      agent.abortRun();
      yield eventChunk({ langgraph_node: "agent" });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
      yield eventChunk({ langgraph_node: "agent", run_id: SERVER_RUN_ID });
    }
    useStream(agent, chunks);

    await agent.runAgent({ runId: CLIENT_RUN_ID });

    expect(cancel.accepted).toEqual([SERVER_RUN_ID]);
    expectSettled(agent);

    // The stop belonged to that run alone: the next one is not cancelled.
    useStream(agent, serverIdentifiedChunks);
    await agent.runAgent({ runId: "client-run-2" });

    expect(cancel.accepted).toEqual([SERVER_RUN_ID]);
    expectSettled(agent);
  });

  it("delivers a stop that lands before the stream opens, then runs again", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    // Stop window two: runAgent sets isRunning, then awaits onInitialize, and
    // only afterwards reaches runAgentStream. A stop in that window has no
    // activeRun to cancel and no stream loop to observe it.
    const stopping = vi
      .spyOn(agent as any, "onInitialize")
      .mockImplementation(async () => {
        agent.abortRun();
      });
    useStream(agent, serverIdentifiedChunks);

    await agent.runAgent({ runId: CLIENT_RUN_ID });
    stopping.mockRestore();

    expect(cancel.accepted).toEqual([SERVER_RUN_ID]);
    expectSettled(agent);

    useStream(agent, serverIdentifiedChunks);
    await agent.runAgent({ runId: "client-run-2" });

    expect(cancel.accepted).toEqual([SERVER_RUN_ID]);
    expectSettled(agent);
  });

  it("does not carry a pre-stream stop into the next run", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    // First run: stopped before the stream opens, then it fails before
    // runAgentStream is ever reached, so nothing consumes the pending stop.
    const failing = vi
      .spyOn(agent as any, "onInitialize")
      .mockImplementation(async () => {
        agent.abortRun();
        throw new Error("initialization failed");
      });
    await expect(
      agent.runAgent({ runId: "client-run-doomed" }),
    ).rejects.toThrow("initialization failed");
    failing.mockRestore();

    // Second run: a fresh, un-stopped run. It must stream normally.
    useStream(agent, serverIdentifiedChunks);
    await agent.runAgent({ runId: CLIENT_RUN_ID });

    expect(cancel.accepted).toEqual([]);
    expectSettled(agent);
  });

  it("does not let a stop pending on the original cancel its clone's first run", async () => {
    const cancel = cancelSpy();
    const agent = createAgent(cancel);

    // The runtime clones an agent per request. If it clones while a stop is
    // pending on the original's in-flight run, the clone must not inherit it.
    let clone: LangGraphAgent | undefined;
    const stopping = vi
      .spyOn(agent as any, "onInitialize")
      .mockImplementation(async () => {
        agent.abortRun();
        clone = agent.clone() as LangGraphAgent;
      });
    useStream(agent, serverIdentifiedChunks);

    await agent.runAgent({ runId: CLIENT_RUN_ID });
    stopping.mockRestore();

    // The original's own stop still lands.
    expect(cancel.accepted).toEqual([SERVER_RUN_ID]);

    // Nobody stopped the clone's run, so nothing may cancel it.
    expect(clone).toBeDefined();
    expect((clone as any).abortBeforeStreamOpen).toBe(false);
    clone!.threadId = THREAD_ID;
    useStream(clone!, serverIdentifiedChunks);
    await clone!.runAgent({ runId: "clone-run-1" });

    expect(cancel.accepted).toEqual([SERVER_RUN_ID]);
    expectSettled(clone!);
  });
});
