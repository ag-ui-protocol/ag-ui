import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import type { ThreadState } from "@langchain/langgraph-sdk";
import { firstValueFrom, tap, toArray } from "rxjs";
import { LangGraphAgent, type ProcessedEvents } from "./agent";
import type { State } from "./types";

const state: ThreadState<State> = {
  values: { messages: [] },
  next: [],
  tasks: [],
  metadata: {},
  checkpoint: {
    checkpoint_id: "cp",
    checkpoint_ns: "",
    thread_id: "thread",
    checkpoint_map: {},
  },
  created_at: null,
  parent_checkpoint: null,
};
function frame(method: string, data: unknown) {
  return {
    type: "event" as const,
    seq: 1,
    method,
    params: { namespace: [], timestamp: 0, data },
  };
}
const wrap = (payload: ProcessedEvents) =>
  frame("custom", { name: "agui", payload });
const status = (value: string) =>
  wrap({ type: EventType.CUSTOM, name: "__ag_ui_transformer_status__", value });
class TestAgent extends LangGraphAgent {
  drain(frames: ReturnType<typeof frame>[]) {
    return this.streamThroughRootTerminal({
      isPaused: false,
      pause() {},
      resume() {},
      async *[Symbol.asyncIterator]() {
        yield* frames;
        // A thread connection remains open after the cancelled run ends.
        await new Promise<void>(() => {});
      },
    });
  }
}
async function runCancellation(
  terminal: "interrupted" | "completed" | "failed",
  finished = false,
  persistedStatus: "interrupted" | "error" | "running" | Error = "error",
) {
  const agent = new TestAgent({
    graphId: "chat",
    deploymentUrl: "http://localhost:2024",
  });
  agent.assistant = {
    assistant_id: "assistant",
    graph_id: "chat",
    config: {},
    context: {},
    created_at: "",
    updated_at: "",
    metadata: {},
    version: 1,
    name: "chat",
  };
  const cancel = vi
    .spyOn(agent.client.runs, "cancel")
    .mockResolvedValue(undefined);
  const getRun = vi.spyOn(agent.client.runs, "get");
  if (persistedStatus instanceof Error)
    getRun.mockRejectedValue(persistedStatus);
  else
    getRun.mockResolvedValue({
      run_id: "server-run",
      thread_id: "thread",
      assistant_id: "assistant",
      created_at: "",
      updated_at: "",
      status: persistedStatus,
      metadata: {},
      multitask_strategy: "reject",
    });
  vi.spyOn(agent.client.threads, "getState").mockResolvedValue(state);
  const frames = [
    status("started"),
    wrap({ type: EventType.STEP_STARTED, stepName: "chat" }),
    wrap({ type: EventType.REASONING_START, messageId: "reasoning" }),
    wrap({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "reasoning",
      role: "reasoning",
    }),
    wrap({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool",
      toolCallName: "search",
    }),
    wrap({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "message",
      role: "assistant",
    }),
    wrap({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message",
      delta: "first",
    }),
    wrap({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message",
      delta: "discarded",
    }),
    frame("lifecycle", {
      event: terminal,
      ...(terminal === "failed"
        ? {
            error:
              persistedStatus === "interrupted"
                ? "An internal error occurred"
                : "provider failed",
          }
        : {}),
    }),
    ...(finished ? [status("finished")] : []),
  ];
  vi.spyOn(agent, "prepareStream").mockImplementation(async () => {
    agent.activeRun!.isV3 = true;
    agent.activeRun!.id = "server-run";
    agent.activeRun!.serverRunIdKnown = true;
    return {
      streamResponse: agent.drain(frames),
      state,
      terminal: {},
      close() {},
    };
  });
  let completed = false;
  const result = firstValueFrom(
    agent
      .run({
        threadId: "thread",
        runId: "run",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .pipe(
        tap((event) => {
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) agent.abortRun();
        }),
        verifyEvents(),
        toArray(),
        tap(() => {
          completed = true;
        }),
      ),
  );
  // Attach a handler before advancing timers so verifier failures are observed.
  const settled = result.then(
    (events) => ({ events }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(100);
  const completedPromptly = completed;
  await vi.advanceTimersByTimeAsync(30_000);
  const outcome = await settled;
  return { outcome, completedPromptly, cancel, getRun };
}
afterEach(() => vi.useRealTimers());
describe("V3 transformer cancellation", () => {
  it.each([false, true])(
    "balances emitted spans and promptly settles a confirmed cancellation (finished marker=%s)",
    async (finished) => {
      vi.useFakeTimers();
      const { outcome, completedPromptly, cancel } = await runCancellation(
        "interrupted",
        finished,
      );
      expect(outcome).not.toHaveProperty("error");
      if (!("events" in outcome)) throw outcome.error;
      expect(outcome.events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        runId: "server-run",
      });
      expect(completedPromptly).toBe(true);
      expect(cancel).toHaveBeenCalledExactlyOnceWith("thread", "server-run");
      expect(
        outcome.events.filter(
          (event) => event.type === EventType.TEXT_MESSAGE_CONTENT,
        ),
      ).toEqual([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "message",
          delta: "first",
        },
      ]);
      for (const type of [
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_END,
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.STEP_FINISHED,
      ]) {
        expect(
          outcome.events.filter((event) => event.type === type),
        ).toHaveLength(1);
      }
    },
  );
  it.each(["error", "running"] as const)(
    "preserves a root failure when persisted status is %s",
    async (persistedStatus) => {
      vi.useFakeTimers();
      const { outcome } = await runCancellation(
        "failed",
        true,
        persistedStatus,
      );
      expect(outcome).not.toHaveProperty("error");
      if (!("events" in outcome)) throw outcome.error;
      expect(outcome.events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        message: "provider failed",
      });
    },
  );
  it("settles Python's synthetic failed lifecycle only when the own run is confirmed interrupted", async () => {
    vi.useFakeTimers();
    const { outcome, completedPromptly, getRun } = await runCancellation(
      "failed",
      false,
      "interrupted",
    );
    expect(outcome).not.toHaveProperty("error");
    if (!("events" in outcome)) throw outcome.error;
    expect(outcome.events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "server-run",
    });
    expect(completedPromptly).toBe(true);
    expect(getRun).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "server-run",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("surfaces a failed cancellation-status lookup", async () => {
    vi.useFakeTimers();
    const { outcome } = await runCancellation(
      "failed",
      false,
      new Error("Run not found"),
    );
    expect(outcome).not.toHaveProperty("error");
    if (!("events" in outcome)) throw outcome.error;
    expect(outcome.events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "Run not found",
    });
  });
  it("still rejects missing transformer finalization when the root completed despite cancellation", async () => {
    vi.useFakeTimers();
    const { outcome, completedPromptly } = await runCancellation("completed");
    expect(completedPromptly).toBe(false);
    expect(outcome).not.toHaveProperty("error");
    if (!("events" in outcome)) throw outcome.error;
    expect(outcome.events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: expect.stringContaining("transformer did not finish"),
    });
  });
});
