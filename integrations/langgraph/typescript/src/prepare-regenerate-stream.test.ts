/**
 * `prepareRegenerateStream` routes by the auto-detected protocol
 * (supportsV3 OPTIONS probe), not a config flag:
 *
 *  - v3 server (probe non-404): regen acquires the cached per-thread
 *    ThreadStream and calls
 *    `streamingThread.submitRun({ ..., forkFrom: { checkpointId } })`
 *    against the shared raw-channel subscription. `forkFrom.checkpointId`
 *    points at the forked checkpoint produced by `threads.updateState`.
 *
 *  - legacy server (probe 404): regen uses
 *    `this.client.runs.stream(threadId, assistantId, payload)`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThreadStream() {
  const aguiSub = {
    pause: vi.fn(),
    resume: vi.fn(),
    [Symbol.asyncIterator]: async function* () {},
  };
  const thread: any = {
    interrupts: [],
    subscribe: vi.fn().mockResolvedValue(aguiSub),
    onEvent: vi.fn().mockReturnValue(() => {}),
    submitRun: vi.fn().mockResolvedValue({ run_id: "regen-run" }),
    respondInput: vi.fn().mockResolvedValue(undefined),
  };
  return { thread, aguiSub };
}

function makeConfig(opts: { v3: boolean }) {
  // Protocol is auto-detected via an OPTIONS probe of
  // /threads/:id/stream/events (supportsV3). Stub fetch: a non-404 routes
  // regen through the v3 ThreadStream path; a 404 falls back to legacy
  // client.runs.stream.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ status: opts.v3 ? 200 : 404 } as Response),
  );
  const threadStreams = new Map<string, ReturnType<typeof makeThreadStream>>();
  // LangGraph's `threads.getHistory` returns checkpoints newest-first.
  // `getCheckpointByMessage` reverses to walk oldest→newest and finds
  // the FIRST checkpoint containing the target message — that's the
  // one we regenerate from. Order this fixture the same way.
  const history = [
    {
      // Newer checkpoint with a follow-up assistant message.
      values: {
        messages: [
          { id: "u1", type: "human", content: "first" } as LangGraphMessage,
          { id: "a1", type: "ai", content: "answer" } as LangGraphMessage,
        ],
      },
      checkpoint: { checkpoint_id: "ck-new" },
      parent_checkpoint: { checkpoint_id: "ck-old", checkpoint_ns: "" },
      next: [],
      tasks: [],
      metadata: {},
    },
    {
      // Older checkpoint — contains only the message we'll regenerate
      // from; no `messagesAfter`, so the search terminates here.
      values: {
        messages: [
          { id: "u1", type: "human", content: "first" } as LangGraphMessage,
        ],
      },
      checkpoint: { checkpoint_id: "ck-old" },
      parent_checkpoint: null,
      next: ["model"],
      tasks: [],
      metadata: {},
    },
  ];

  const client: any = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      // The state-after-fork response — its checkpoint_id is what should
      // be passed to submitRun's `forkFrom`.
      updateState: vi.fn().mockResolvedValue({
        checkpoint: { checkpoint_id: "ck-fork" },
      }),
      getHistory: vi.fn().mockResolvedValue(history),
      getState: vi.fn().mockResolvedValue({
        values: { messages: [] },
        tasks: [],
        next: [],
        metadata: {},
      }),
      stream: vi.fn((threadId: string) => {
        let entry = threadStreams.get(threadId);
        if (!entry) {
          entry = makeThreadStream();
          threadStreams.set(threadId, entry);
        }
        return entry.thread;
      }),
    },
    runs: {
      cancel: vi.fn(),
      // Legacy regen path target.
      stream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {},
      }),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([
        { assistant_id: "asst-1", graph_id: "test-graph", config: {}, metadata: {} },
      ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {} } },
        output_schema: { properties: { messages: {} } },
        config_schema: { properties: {} },
        context_schema: { properties: {} },
      }),
    },
  };

  const config: LangGraphAgentConfig = {
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
    client,
  };
  return { config, client, threadStreams };
}

function makeAgent(config: LangGraphAgentConfig) {
  const agent = new LangGraphAgent(config);
  agent.dispatchEvent = (e: any) => e as any;
  // prepareRegenerateStream needs `activeRun` to be set (it reads
  // `activeRun!.schemaKeys`). Stub minimal shape — runAgentStream would
  // normally populate this.
  (agent as any).activeRun = {
    id: "run-regen",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  return agent;
}

const regenInput = {
  threadId: "thread-1",
  runId: "run-regen",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  messageCheckpoint: {
    id: "u1",
    type: "human",
    content: "first",
  } as LangGraphMessage,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prepareRegenerateStream — transformer parity", () => {
  it("v3 server → routes regen through cached ThreadStream's submitRun with forkFrom.checkpointId", async () => {
    const { config, client, threadStreams } = makeConfig({ v3: true });
    const agent = makeAgent(config);

    await agent.prepareRegenerateStream(regenInput as any, ["events", "values"]);

    // The legacy path MUST NOT be used when the transformer is on.
    expect(client.runs.stream).not.toHaveBeenCalled();

    const entry = threadStreams.get("thread-1");
    expect(entry).toBeDefined();
    expect(entry!.thread.submitRun).toHaveBeenCalledTimes(1);

    const payload = entry!.thread.submitRun.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        forkFrom: expect.objectContaining({ checkpointId: "ck-fork" }),
      }),
    );
  });

  it("v3 server → opens / reuses the same raw-channel subscription as prepareStream", async () => {
    const { config, threadStreams } = makeConfig({ v3: true });
    const agent = makeAgent(config);

    await agent.prepareRegenerateStream(regenInput as any, ["events", "values"]);
    const entry = threadStreams.get("thread-1");
    expect(entry).toBeDefined();
    // Exactly one subscription was opened — the SAME shared-cache rule
    // prepareStream uses. The v3 path subscribes to the raw protocol
    // channels (DEFAULT_STREAM_MODES), not the compile-time custom:agui.
    expect(entry!.thread.subscribe).toHaveBeenCalledTimes(1);
    const subArg = entry!.thread.subscribe.mock.calls[0][0];
    expect(Array.isArray(subArg)).toBe(true);
    expect(subArg).toContain("messages");
    expect(subArg).toContain("custom");
  });

  it("legacy server → falls back to client.runs.stream (legacy behavior preserved)", async () => {
    const { config, client, threadStreams } = makeConfig({ v3: false });
    const agent = makeAgent(config);

    await agent.prepareRegenerateStream(regenInput as any, ["events", "values"]);

    expect(client.runs.stream).toHaveBeenCalledTimes(1);
    const [threadIdArg, assistantIdArg, payload] = client.runs.stream.mock.calls[0];
    expect(threadIdArg).toBe("thread-1");
    expect(assistantIdArg).toBe("asst-1");
    expect(payload).toEqual(
      expect.objectContaining({
        checkpointId: "ck-fork",
      }),
    );

    // No ThreadStream / submitRun involvement when useTransformer is off.
    expect(threadStreams.size).toBe(0);
  });
});
