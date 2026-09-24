import { describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { Subscriber } from "rxjs";
import type { ProtocolEvent } from "@langchain/langgraph";
import type {
  ThreadState,
  ThreadStream,
  SubscriptionHandle,
} from "@langchain/langgraph-sdk";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import type { State } from "./types";

const state: ThreadState<State> = {
  values: { messages: [] },
  next: [],
  tasks: [],
  metadata: { writes: {} },
  checkpoint: {
    checkpoint_id: "cp",
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
  node = "chat",
  namespace: string[] = [],
): ProtocolEvent {
  return {
    type: "event",
    method,
    params: { namespace, node, timestamp: 0, data },
  } as ProtocolEvent;
}
async function* events(chunks: ProtocolEvent[]) {
  yield* chunks;
}
class TestAgent extends LangGraphAgent {
  drain(
    subscription: AsyncIterable<ProtocolEvent> & {
      isPaused: boolean;
      resume(): void;
      pause(): void;
    },
    isResume = false,
  ) {
    return this.streamThroughRootTerminal(subscription, isResume);
  }
  watch(
    thread: ThreadStream,
    sub: SubscriptionHandle<never, ProtocolEvent>,
    terminal: { error?: string },
  ) {
    return this.watchForRootTerminal(thread, sub, terminal);
  }
}
async function run(
  chunks: ProtocolEvent[],
  options: {
    terminal?: { error?: string };
    interrupted?: boolean;
    serverRunId?: string;
    cancelled?: boolean;
    resumed?: boolean;
    knownRunId?: boolean;
  } = {},
) {
  const agent = new TestAgent({
    graphId: "test",
    deploymentUrl: "http://localhost:2024",
  });
  let finalState = options.interrupted
    ? {
        ...state,
        next: ["chat"],
        tasks: [
          {
            id: "task",
            name: "chat",
            error: null,
            checkpoint: null,
            state: null,
            interrupts: [{ id: "int", value: "approve" }],
          },
        ],
      }
    : state;
  if (options.serverRunId)
    finalState = {
      ...finalState,
      metadata: { ...finalState.metadata, run_id: options.serverRunId },
    };
  const getState = vi
    .spyOn(agent.client.threads, "getState")
    .mockResolvedValue(finalState);
  const emitted: ProcessedEvents[] = [];
  const error = vi.fn();
  agent.dispatchEvent = (e) => {
    emitted.push(e);
    return true;
  };
  agent.activeRun = {
    id: "run",
    resumedRunIdPending: options.resumed,
    serverRunIdKnown: options.knownRunId,
    threadId: "thread",
    usage: [],
    textBlockMessageIds: new Map(),
    toolBlocks: new Map(),
    reasoningBlocks: new Map(),
  };
  const cancel = vi
    .spyOn(agent.client.runs, "cancel")
    .mockResolvedValue(undefined);
  let consumed = 0;
  async function* stream() {
    if (options.cancelled) {
      agent.abortRun();
      await Promise.resolve();
    }
    for (const chunk of chunks) {
      consumed++;
      yield chunk;
    }
  }
  await agent.handleStreamEventsV3(
    {
      streamResponse: stream(),
      state,
      terminal: options.terminal ?? {},
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
      forwardedProps: { nodeName: "chat" },
    },
    [],
  );
  expect(error).not.toHaveBeenCalled();
  return { emitted, getState, consumed, cancel };
}
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
const metadata = { ls_provider: "openai", ls_model_name: "model" };
const start = (id: string, node = "chat") =>
  event("messages", { event: "message-start", id, metadata }, node);
const finish = (node = "chat") =>
  event("messages", { event: "message-finish", usage }, node);
const passthrough = event("custom", {
  name: "agui",
  payload: { type: EventType.CUSTOM, name: "test", value: null },
});

describe("v3 terminal failures", () => {
  it.each([false, true])(
    "emits the declared resume state reset only on resume (%s)",
    async (isResume) => {
      const agent = new TestAgent({
        graphId: "test",
        deploymentUrl: "http://localhost:2024",
      });
      const step = event("custom", {
        name: "agui",
        payload: { type: EventType.STEP_STARTED, stepName: "resume" },
      });
      const snapshot = event("custom", {
        name: "agui",
        payload: { type: EventType.STATE_SNAPSHOT, snapshot: { count: 1 } },
      });
      const terminal = event("lifecycle", { event: "completed" });
      const frames = [
        event("custom", {
          name: "agui",
          payload: {
            type: EventType.CUSTOM,
            name: "__ag_ui_transformer_status__",
            value: { phase: "started", resetStateOnResume: true },
          },
        }),
        step,
        snapshot,
        event("custom", {
          name: "agui",
          payload: {
            type: EventType.CUSTOM,
            name: "__ag_ui_transformer_status__",
            value: "finished",
          },
        }),
        terminal,
      ];
      const subscription = {
        isPaused: false,
        resume() {
          this.isPaused = false;
        },
        pause() {
          this.isPaused = true;
        },
        [Symbol.asyncIterator]: () => events(frames),
      };
      const received = [];
      for await (const frame of agent.drain(subscription, isResume))
        received.push(frame);
      const reset = event("custom", {
        name: "agui",
        payload: { type: EventType.STATE_SNAPSHOT, snapshot: {} },
      });
      expect(received).toEqual(
        isResume
          ? [step, reset, snapshot, terminal]
          : [step, snapshot, terminal],
      );
    },
  );
  it("uses the completed checkpoint's resumed run identity", async () => {
    const { emitted } = await run([], {
      serverRunId: "resumed-run",
      resumed: true,
    });
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "resumed-run",
    });
  });

  it("does not replace a known run ID with a later checkpoint's run", async () => {
    const { emitted } = await run([], {
      serverRunId: "another-run",
      resumed: true,
      knownRunId: true,
    });
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "run",
    });
  });

  it("drains a cancelled stream even if abortRun already sent cancellation", async () => {
    const { emitted, consumed, cancel } = await run(
      [passthrough, passthrough],
      { cancelled: true },
    );
    expect(consumed).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      emitted.some((e) => e.type === EventType.CUSTOM && e.name === "test"),
    ).toBe(false);
  });
  it("drains its own final snapshots after an early SDK lifecycle pause", async () => {
    const agent = new TestAgent({
      graphId: "test",
      deploymentUrl: "http://localhost:2024",
    });
    const snapshot = event("custom", {
      name: "agui",
      payload: { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
    });
    const terminal = event("lifecycle", { event: "completed" }, "", []);
    const next = vi
      .fn<() => Promise<IteratorResult<ProtocolEvent>>>()
      .mockResolvedValueOnce({ done: true, value: undefined })
      .mockResolvedValueOnce({ done: false, value: snapshot })
      .mockResolvedValueOnce({ done: false, value: terminal });
    const close = vi.fn();
    const subscription = {
      isPaused: true,
      resume: vi.fn(() => {
        subscription.isPaused = false;
      }),
      pause: vi.fn(() => {
        subscription.isPaused = true;
      }),
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    };
    const received: ProtocolEvent[] = [];
    for await (const frame of agent.drain(subscription)) received.push(frame);
    expect(received).toEqual([snapshot, terminal]);
    expect(subscription.resume).toHaveBeenCalledOnce();
    expect(subscription.pause).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("drains transformer finalization after an early interrupt and leaves the next run clean", async () => {
    const agent = new TestAgent({
      graphId: "test",
      deploymentUrl: "http://localhost:2024",
    });
    const status = (value: string) =>
      event("custom", {
        name: "agui",
        payload: {
          type: EventType.CUSTOM,
          name: "__ag_ui_transformer_status__",
          value,
        },
      });
    const terminal = event("lifecycle", { event: "interrupted" }, "", []);
    const snapshot = event("custom", {
      name: "agui",
      payload: { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
    });
    const frames = [
      status("started"),
      terminal,
      snapshot,
      status("finished"),
      status("started"),
      snapshot,
      status("finished"),
      event("lifecycle", { event: "completed" }, "", []),
    ];
    const subscription = {
      isPaused: false,
      resume() {
        this.isPaused = false;
      },
      pause() {
        this.isPaused = true;
      },
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ProtocolEvent>> =>
          frames.length
            ? { done: false, value: frames.shift()! }
            : { done: true, value: undefined },
      }),
    };
    const first = [];
    for await (const frame of agent.drain(subscription)) first.push(frame);
    expect(first).toEqual([terminal, snapshot]);
    subscription.resume();
    const second = [];
    for await (const frame of agent.drain(subscription)) second.push(frame);
    expect(second).toEqual([
      snapshot,
      event("lifecycle", { event: "completed" }, "", []),
    ]);
    expect(frames).toEqual([]);
  });

  it("retains terminal failure without pausing another subscription early", async () => {
    const agent = new TestAgent({
      graphId: "test",
      deploymentUrl: "http://localhost:2024",
    });
    let callback!: (event: ProtocolEvent) => void;
    const thread = {
      onEvent: (listener: typeof callback) => {
        callback = listener;
        return vi.fn();
      },
    } as unknown as ThreadStream;
    const pause = vi.fn();
    const terminal: { error?: string } = {};
    agent.watch(
      thread,
      { pause } as unknown as SubscriptionHandle<never, ProtocolEvent>,
      terminal,
    );
    callback(event("lifecycle", { event: "failed", error: "provider failed" }));
    expect(pause).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(pause).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pause).not.toHaveBeenCalled();
    const { emitted, getState } = await run([], { terminal });
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "provider failed",
    });
    expect(getState).not.toHaveBeenCalled();
  });
  it("reports a raw failed lifecycle and never emits successful completion", async () => {
    const { emitted, getState } = await run([
      start("m"),
      event("messages", {
        event: "content-block-start",
        index: 0,
        content: { type: "text" },
      }),
      event("lifecycle", { event: "failed", error: "failed" }),
    ]);
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "failed",
    });
    expect(emitted.some((e) => e.type === EventType.TEXT_MESSAGE_END)).toBe(
      true,
    );
    expect(emitted.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
    expect(getState).not.toHaveBeenCalled();
  });
  it("stops after transformer RUN_ERROR without duplicating the terminal", async () => {
    const { emitted } = await run(
      [
        event("custom", {
          name: "agui",
          payload: { type: EventType.RUN_ERROR, message: "failed" },
        }),
        event("error", { message: "failed" }),
      ],
      { terminal: { error: "failed" } },
    );
    expect(emitted.filter((e) => e.type === EventType.RUN_ERROR)).toHaveLength(
      1,
    );
    expect(emitted.at(-1)?.type).toBe(EventType.RUN_ERROR);
  });
});
describe("v3 usage", () => {
  it.each([false, true])(
    "counts latest snapshots once, transformer=%s",
    async (transformer) => {
      const { emitted } = await run([
        ...(transformer ? [passthrough] : []),
        start("m"),
        event("messages", { event: "usage", usage: { input_tokens: 50 } }),
        event("messages", { event: "usage", usage }),
        finish(),
      ]);
      expect(emitted.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        usage: [
          {
            provider: "openai",
            model: "model",
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          },
        ],
      });
    },
  );
  it("keeps interleaved messages separate even when frame IDs are omitted", async () => {
    const { emitted } = await run([
      start("a", "one"),
      start("b", "two"),
      finish("one"),
      finish("two"),
    ]);
    expect(emitted.at(-1)).toMatchObject({ usage: [{ totalTokens: 240 }] });
  });
  it("includes usage on interrupted runs", async () => {
    const { emitted } = await run([start("m"), finish()], {
      interrupted: true,
    });
    expect(emitted.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      usage: [{ totalTokens: 120 }],
    });
  });
  it("omits usage when none was measured", async () => {
    const { emitted } = await run([
      start("m"),
      event("messages", { event: "message-finish" }),
    ]);
    expect(emitted.at(-1)).not.toHaveProperty("usage");
  });
});

describe("transformer extension channel detection", () => {
  const encodings = [
    {
      label: "current direct",
      wrap: (payload: object) => event("custom:agui", payload),
    },
    {
      label: "current remote name",
      wrap: (payload: object) =>
        event("custom", { name: "custom:agui", payload }),
    },
    {
      label: "current remote type",
      wrap: (payload: object) =>
        event("custom", { type: "custom:agui", payload }),
    },
    {
      label: "legacy direct",
      wrap: (payload: object) => event("agui", payload),
    },
    {
      label: "legacy remote",
      wrap: (payload: object) => event("custom", { name: "agui", payload }),
    },
  ];
  it.each(encodings)(
    "uses $label as the single translator after initial raw frames",
    async ({ wrap }) => {
      const messageId = "m";
      const { emitted } = await run([
        event("lifecycle", { event: "started", graph_name: "chat" }),
        start(messageId),
        wrap({ type: EventType.STEP_STARTED, stepName: "chat" }),
        wrap({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        }),
        event("messages", {
          event: "content-block-start",
          index: 0,
          content: { type: "text" },
        }),
        wrap({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: "hello",
        }),
        event("messages", {
          event: "content-block-delta",
          index: 0,
          delta: { type: "text-delta", text: "hello" },
        }),
        wrap({ type: EventType.TEXT_MESSAGE_END, messageId }),
        event("messages", {
          event: "content-block-finish",
          index: 0,
          content: { type: "text" },
        }),
        wrap({ type: EventType.STEP_FINISHED, stepName: "chat" }),
        event("messages", { event: "message-finish" }),
      ]);
      expect(
        emitted.filter((e) => e.type === EventType.TEXT_MESSAGE_START),
      ).toHaveLength(1);
      expect(
        emitted.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT),
      ).toEqual([
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "hello" },
      ]);
      expect(
        emitted.filter((e) => e.type === EventType.TEXT_MESSAGE_END),
      ).toHaveLength(1);
      expect(emitted.filter((e) => e.type === EventType.CUSTOM)).toHaveLength(
        0,
      );
      const steps = new Set<string>();
      for (const item of emitted) {
        if (item.type === EventType.STEP_STARTED) {
          expect(steps.has(item.stepName)).toBe(false);
          steps.add(item.stepName);
        }
        if (item.type === EventType.STEP_FINISHED) {
          expect(steps.delete(item.stepName)).toBe(true);
        }
      }
      expect(steps.size).toBe(0);
    },
  );
  it("leaves unrelated named custom events alone", async () => {
    const { emitted } = await run([
      event("custom", {
        name: "custom:application",
        payload: { type: "notice", message: "hello" },
      }),
    ]);
    expect(emitted).toContainEqual({
      type: EventType.CUSTOM,
      name: "custom:application",
      value: { type: "notice", message: "hello" },
    });
  });
});
