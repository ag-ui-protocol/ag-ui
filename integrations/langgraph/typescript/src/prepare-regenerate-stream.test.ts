/**
 * Failing tests describing the target shape of `prepareRegenerateStream`
 * after the upcoming refactor.
 *
 * Today, `prepareRegenerateStream` unconditionally goes through
 * `this.client.runs.stream(...)`, even when `useTransformer: true`. That
 * means a regenerate doesn't get the AG-UI transformer's `custom:agui`
 * channel and skips the cached per-thread ThreadStream entirely — so
 * regen events round-trip through the legacy translator instead of the
 * transformer.
 *
 * After the refactor:
 *
 *  - When `useTransformer: true` AND a ThreadStream can be acquired
 *    (existing cache entry or a fresh one) for the threadId, regen calls
 *    `streamingThread.submitRun({ ..., forkFrom: { checkpointId } })`
 *    against the cached `custom:agui` subscription. `forkFrom.checkpointId`
 *    points at the forked checkpoint produced by `threads.updateState`.
 *
 *  - When `useTransformer: false`, behavior is unchanged: regen uses
 *    `this.client.runs.stream(threadId, assistantId, payload)`.
 */

import { describe, it, expect, vi } from "vitest";
import type { Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { LangGraphAgent } from "./agent";
import type { LangGraphAgentConfig } from "./agent";

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

function makeConfig(opts: { useTransformer: boolean }) {
  const threadStreams = new Map<string, ReturnType<typeof makeThreadStream>>();
  const history = [
    {
      // Older checkpoint — includes the message we'll regenerate from.
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
    useTransformer: opts.useTransformer,
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
  it("useTransformer: true → routes regen through cached ThreadStream's submitRun with forkFrom.checkpointId", async () => {
    const { config, client, threadStreams } = makeConfig({ useTransformer: true });
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

  it("useTransformer: true → opens / reuses the same custom:agui subscription as prepareStream", async () => {
    const { config, threadStreams } = makeConfig({ useTransformer: true });
    const agent = makeAgent(config);

    await agent.prepareRegenerateStream(regenInput as any, ["events", "values"]);
    const entry = threadStreams.get("thread-1");
    expect(entry).toBeDefined();
    // Exactly one subscription was opened — the SAME shared-cache rule
    // prepareStream uses.
    expect(entry!.thread.subscribe).toHaveBeenCalledTimes(1);
    expect(entry!.thread.subscribe).toHaveBeenCalledWith(["custom:agui"]);
  });

  it("useTransformer: false → falls back to client.runs.stream (legacy behavior preserved)", async () => {
    const { config, client, threadStreams } = makeConfig({ useTransformer: false });
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
