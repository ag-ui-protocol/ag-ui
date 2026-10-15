import { afterEach, describe, expect, it, vi } from "vitest";
import { Subscriber } from "rxjs";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import type { ProtocolEvent as ServerEvent } from "@langchain/langgraph";
import { SubscriptionHandle, type Assistant } from "@langchain/langgraph-sdk";

type Frame = ServerEvent & { event_id?: string };
const assistant: Assistant = {
  assistant_id: "assistant",
  graph_id: "test",
  config: {},
  context: {},
  created_at: "",
  updated_at: "",
  metadata: {},
  version: 1,
  name: "test",
};
const input = {
  threadId: "thread",
  runId: "run",
  state: {},
  messages: [],
  tools: [],
  context: [],
  forwardedProps: {},
};
// Python EventStreamingSession._synth_event_id joins discriminator parts
// with "|": root lifecycle is `synth:<run-id>:lc||running`.
function frame(
  method: string,
  data: unknown,
  seq = 1,
  event_id?: string,
): Frame {
  return {
    type: "event",
    method,
    seq,
    event_id,
    params: { namespace: [], timestamp: 0, data },
  };
}
function subscription(frames: Frame[]) {
  return {
    isPaused: false,
    pause() {
      this.isPaused = true;
    },
    resume() {
      this.isPaused = false;
    },
    async *[Symbol.asyncIterator]() {
      yield* frames;
    },
  };
}
class TestAgent extends LangGraphAgent {
  acquire(threadId = "thread") {
    return this.acquireTransformerThread(threadId);
  }
  release(threadId = "thread") {
    return this.releaseTransformerThread(threadId);
  }
  filtered(frames: Frame[], runId = "current", fence?: number) {
    return this.currentRunEvents(subscription(frames), runId, fence);
  }
  terminal(sub: ReturnType<typeof subscription>) {
    return this.streamThroughRootTerminal(sub);
  }
}
function agent() {
  const current = new TestAgent({
    graphId: "test",
    deploymentUrl: "http://localhost:2024",
  });
  current.assistant = assistant;
  return current;
}
async function collect(stream: AsyncIterable<Frame>) {
  const result: Frame[] = [];
  for await (const event of stream) result.push(event);
  return result;
}
afterEach(() => vi.useRealTimers());

describe("request-owned V3 streams", () => {
  it.each([false, true])(
    "closes all resources after subscription %s",
    async (fails) => {
      const current = agent();
      const thread = current.client.threads.stream("thread", {
        assistantId: "assistant",
      });
      const close = vi.spyOn(thread, "close").mockResolvedValue();
      vi.spyOn(current.client.threads, "stream").mockReturnValue(thread);
      const handle = new SubscriptionHandle(
        "sub",
        { channels: ["lifecycle"] },
        async () => {},
      );
      const subscribe = vi.spyOn(thread, "subscribe");
      if (fails) subscribe.mockRejectedValue(new Error("subscribe failed"));
      else subscribe.mockResolvedValue(handle);
      vi.spyOn(thread.agent, "getTree").mockRejectedValue(
        Object.assign(new Error("No active run"), { code: "no_such_run" }),
      );
      if (fails)
        await expect(current.acquire()).rejects.toThrow("subscribe failed");
      else {
        await current.acquire();
        expect(current.transformerThreads.size).toBe(1);
        await current.release();
      }
      expect(close).toHaveBeenCalledOnce();
      expect(current.transformerThreads.size).toBe(0);
    },
  );
  it("closes a connection when the observer cancels while subscribe is pending", async () => {
    const current = agent();
    current.subscriber = new Subscriber<ProcessedEvents>();
    const thread = current.client.threads.stream("thread", {
      assistantId: "assistant",
    });
    const close = vi.spyOn(thread, "close").mockResolvedValue();
    vi.spyOn(current.client.threads, "stream").mockReturnValue(thread);
    let finish!: (value: SubscriptionHandle) => void;
    vi.spyOn(thread, "subscribe").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(thread.agent, "getTree").mockRejectedValue(
      Object.assign(new Error("No active run"), { code: "no_such_run" }),
    );
    const acquiring = current.acquire();
    current.subscriber.unsubscribe();
    expect(close).toHaveBeenCalledOnce();
    finish(
      new SubscriptionHandle(
        "sub",
        { channels: ["lifecycle"] },
        async () => {},
      ),
    );
    await expect(acquiring).rejects.toThrow("cancelled while subscribing");
    expect(current.transformerThreads.size).toBe(0);
  });
  it("discards Python historical runs and preserves the current raw preamble without tasks", async () => {
    const old = [
      frame("lifecycle", { event: "running" }, 1, "synth:old:lc||running"),
      frame("values", { text: "old" }, 2),
      frame("lifecycle", { event: "completed" }, 3),
    ];
    const current = [
      frame("lifecycle", { event: "running" }, 4, "synth:current:lc||running"),
      frame("custom", null, 5),
      frame("values", { text: "current" }, 6),
      frame("lifecycle", { event: "completed" }, 7),
    ];
    expect(await collect(agent().filtered([...old, ...current]))).toEqual(
      current,
    );
  });
  it("skips a large identified historical run without retaining its frames", async () => {
    const old = [
      frame("lifecycle", { event: "running" }, 1, "synth:old:lc||running"),
      ...Array.from({ length: 5000 }, (_, index) =>
        frame("values", { old: index }, index + 2),
      ),
    ];
    const current = [
      frame(
        "lifecycle",
        { event: "running" },
        5002,
        "synth:current:lc||running",
      ),
      frame("lifecycle", { event: "completed" }, 5003),
    ];
    expect(await collect(agent().filtered([...old, ...current]))).toEqual(
      current,
    );
  });
  it("discards TS replay and preserves initial values until task metadata proves run identity", async () => {
    const current = [
      frame("lifecycle", { event: "running" }, 10),
      frame("values", { text: "initial" }, 11),
      frame("tasks", { metadata: { run_id: "current" } }, 12),
      frame("lifecycle", { event: "completed" }, 13),
    ];
    expect(
      await collect(
        agent().filtered(
          [frame("lifecycle", { event: "completed" }, 9), ...current],
          "current",
          9,
        ),
      ),
    ).toEqual(current);
  });
  it("rejects a different run after the current Python run has started", async () => {
    await expect(
      collect(
        agent().filtered([
          frame(
            "lifecycle",
            { event: "running" },
            1,
            "synth:current:lc||running",
          ),
          frame(
            "lifecycle",
            { event: "running" },
            2,
            "synth:other:lc||running",
          ),
        ]),
      ),
    ).rejects.toThrow("different run");
  });
  it.each(["", " "])(
    "rejects an invalid submitted identity before reading replay (%j)",
    async (runId) => {
      await expect(
        collect(
          agent().filtered([frame("lifecycle", { event: "running" })], runId),
        ),
      ).rejects.toThrow("submitted run ID");
    },
  );
  it("fails closed when replay never identifies the submitted run", async () => {
    await expect(
      collect(agent().filtered([frame("lifecycle", { event: "completed" })])),
    ).rejects.toThrow("identifying the current run");
  });
  it("does not accept missing sequence numbers under the TS replay contract", async () => {
    const missing = frame("lifecycle", { event: "running" });
    // A malformed wire envelope is intentionally injected at the input boundary.
    Object.defineProperty(missing, "seq", { value: undefined });
    await expect(
      collect(agent().filtered([missing], "current", 4)),
    ).rejects.toThrow("missing its sequence");
  });
  it("rejects overlapping clone runs before preparation and releases the lease on failure", async () => {
    const first = agent();
    const second = first.clone();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(first, "prepareStream").mockImplementation(async () => {
      await pending;
      throw new Error("first failed");
    });
    const prepareSecond = vi
      .spyOn(second, "prepareStream")
      .mockRejectedValue(new Error("second failed"));
    const running = first.runAgentStream(
      input,
      new Subscriber<ProcessedEvents>(),
    );
    await expect(
      second.runAgentStream(input, new Subscriber<ProcessedEvents>()),
    ).rejects.toThrow("already active");
    expect(prepareSecond).not.toHaveBeenCalled();
    release();
    await expect(running).rejects.toThrow("first failed");
    await expect(
      second.runAgentStream(input, new Subscriber<ProcessedEvents>()),
    ).rejects.toThrow("second failed");
  });
  it("allows the next clone run directly from the previous completion callback", async () => {
    const first = agent();
    const second = first.clone();
    vi.spyOn(first, "prepareStream").mockResolvedValue(undefined);
    const prepareSecond = vi
      .spyOn(second, "prepareStream")
      .mockResolvedValue(undefined);
    const events: ProcessedEvents[] = [];
    await new Promise<void>((resolve, reject) =>
      first.run(input).subscribe({
        complete: () =>
          second.run(input).subscribe({
            next: (event: ProcessedEvents) => events.push(event),
            complete: resolve,
            error: reject,
          }),
        error: reject,
      }),
    );
    expect(prepareSecond).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("already active"),
      }),
    );
  });
  it("does not share authenticated connections with a differently authorized clone", () => {
    const first = agent();
    first.headers = { Authorization: "Bearer first" };
    const second = first.clone();
    second.headers = { Authorization: "Bearer second" };
    expect(first.client).not.toBe(second.client);
    expect(first.transformerThreads).not.toBe(second.transformerThreads);
    expect(first.headers.Authorization).toBe("Bearer first");
  });
  it("bounds a transformer that never finishes after the root terminal", async () => {
    vi.useFakeTimers();
    const chunks = [
      frame("custom", {
        name: "agui",
        payload: {
          type: "CUSTOM",
          name: "__ag_ui_transformer_status__",
          value: "started",
        },
      }),
      frame("lifecycle", { event: "completed" }),
    ];
    const sub = subscription(chunks);
    sub[Symbol.asyncIterator] = async function* () {
      yield* chunks;
      await new Promise<void>(() => {});
    };
    const result = collect(agent().terminal(sub));
    const assertion = expect(result).rejects.toThrow(
      "transformer did not finish",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
