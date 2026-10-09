import { describe, it, expect, vi, afterEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { EventType } from "@ag-ui/core";
import type { AgentSubscriber } from "@ag-ui/client";

/** Canonical interrupt outcomes record pending interrupts; resume[] forwards the answer through the native LangGraph command and clears them. */
function buildPlatformAgent(ids = ["int-1"]) {
  const capturedPayload: { value: Record<string, unknown> | null } = {
    value: null,
  };

  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  // The platform reports an open interrupt until the graph actually runs with
  // the resume command, at which point the interrupt clears — exactly like a
  // real platform. `runs.stream` flips `streamCalled`; the agent re-reads state
  // after streaming (agent.ts post-stream `getState`) and must then see a clean
  // thread so the resume run completes instead of re-emitting the interrupt.
  const interruptState = {
    values: { messages: [] },
    tasks: [
      {
        interrupts: ids.map((id) => ({
          value: { reason: "confirm", message: "ok?" },
          id,
        })),
      },
    ],
    next: ["process_steps_node"],
    metadata: {},
  };
  const resolvedState = {
    values: { messages: [] },
    tasks: [],
    next: [],
    metadata: {},
  };
  let streamCalled = false;

  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi
        .fn()
        .mockImplementation(async () =>
          streamCalled ? resolvedState : interruptState,
        ),
      getHistory: vi.fn().mockResolvedValue([]),
      updateState: vi.fn().mockResolvedValue({}),
    },
    assistants: {
      search: vi.fn().mockResolvedValue([
        {
          assistant_id: "asst-1",
          graph_id: "test-graph",
          config: { configurable: {} },
        },
      ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {}, tools: {} } },
        output_schema: { properties: { messages: {}, tools: {} } },
      }),
    },
    runs: {
      stream: vi
        .fn()
        .mockImplementation((_t: string, _a: string, payload: any) => {
          capturedPayload.value = payload;
          streamCalled = true;
          // Resume run streams to completion with no further chunks.
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => ({ done: true, value: undefined }) };
            },
          };
        }),
    },
  };

  return { agent, capturedPayload, checkpoint: interruptState };
}

/** Capture both the processed run-finished signal and the raw events. */
function captureSubscriber() {
  const runFinished: Array<
    { outcome: "success" } | { outcome: "interrupt"; interruptIds: string[] }
  > = [];
  const rawFinished: any[] = [];
  const subscriber: AgentSubscriber = {
    onRunFinishedEvent: (params) => {
      if (params.outcome === "interrupt") {
        runFinished.push({
          outcome: "interrupt",
          interruptIds: params.interrupts.map((i) => i.id),
        });
      } else {
        runFinished.push({ outcome: "success" });
      }
    },
    onEvent: ({ event }) => {
      if (event.type === EventType.RUN_FINISHED) rawFinished.push(event);
    },
  };
  return { subscriber, runFinished, rawFinished };
}

describe("interrupt outcome + resume[] round-trip (default contract)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("run 1 terminates with RUN_FINISHED outcome=interrupt and records pendingInterrupts", async () => {
    const { agent } = buildPlatformAgent();
    const { subscriber, runFinished, rawFinished } = captureSubscriber();

    await agent.runAgent({ runId: "run-1" } as any, subscriber);

    // Processed layer surfaces the structured interrupt outcome.
    expect(runFinished).toEqual([
      { outcome: "interrupt", interruptIds: ["int-1"] },
    ]);
    // Raw RUN_FINISHED carries the canonical outcome shape.
    expect(rawFinished).toHaveLength(1);
    expect(rawFinished[0].outcome).toEqual({
      type: "interrupt",
      interrupts: [
        expect.objectContaining({
          id: "int-1",
          reason: "confirm",
          message: "ok?",
        }),
      ],
    });
    // AbstractAgent recorded the pending interrupt for the resume guard.
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);
  });

  it("run 2 resumes via canonical RunAgentInput.resume[] and completes", async () => {
    const { agent, capturedPayload } = buildPlatformAgent();

    // Run 1: produce the pending interrupt.
    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.length).toBe(1);

    // Run 2: resolve the interrupt with the canonical resume[] mechanism (NOT
    // the legacy forwardedProps.command.resume channel).
    const { subscriber, runFinished } = captureSubscriber();
    await agent.runAgent(
      {
        runId: "run-2",
        resume: [
          {
            interruptId: "int-1",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      } as any,
      subscriber,
    );

    // The native command addresses the answer by checkpoint interrupt ID.
    expect((capturedPayload.value as any)?.command?.resume).toEqual({
      "int-1": { approved: true },
    });

    // The resume satisfied the guard and cleared the pending interrupt.
    expect(agent.pendingInterrupts.length).toBe(0);

    // The resume run completes — it does NOT re-emit an interrupt outcome.
    expect(runFinished).toEqual([{ outcome: "success" }]);
  });

  it("a normal (non-resume) follow-up run is rejected while the interrupt is pending", async () => {
    const { agent } = buildPlatformAgent();

    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.length).toBe(1);

    // No resume[] -> the base lifecycle guard must reject the run rather than
    // silently dropping the pending interrupt.
    await expect(agent.runAgent({ runId: "run-2" } as any)).rejects.toThrow(
      /pending interrupt/i,
    );
  });
});

describe("checkpoint-authoritative resume validation", () => {
  it("rejects an in-memory pending ID after the checkpoint advances", async () => {
    const { agent, capturedPayload, checkpoint } = buildPlatformAgent();
    await agent.runAgent();
    expect(agent.pendingInterrupts.map((interrupt) => interrupt.id)).toEqual([
      "int-1",
    ]);
    checkpoint.tasks[0].interrupts[0].id = "new-approval";
    const errors: string[] = [];
    await agent.runAgent(
      { resume: [{ interruptId: "int-1", status: "resolved", payload: true }] },
      {
        onRunErrorEvent: ({ event }) => {
          errors.push(event.message);
        },
      },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not open in the checkpoint");
    expect(capturedPayload.value).toBeNull();
  });

  it.each([["wrong"], ["int-1", "int-1"], ["int-1", "stale"]])(
    "rejects invalid IDs on a fresh agent: %j",
    async (...ids) => {
      const { agent, capturedPayload } = buildPlatformAgent();
      expect(agent.pendingInterrupts).toEqual([]);
      const errors: string[] = [];
      await agent.runAgent(
        {
          resume: ids.map((interruptId) => ({
            interruptId,
            status: "resolved",
            payload: true,
          })),
        },
        {
          onRunErrorEvent: ({ event }) => {
            errors.push(event.message);
          },
        },
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/interrupt/i);
      expect(capturedPayload.value).toBeNull();
    },
  );

  it("rejects resume when the checkpoint has no open interrupts", async () => {
    const { agent, capturedPayload } = buildPlatformAgent([]);
    const errors: string[] = [];
    await agent.runAgent(
      {
        resume: [
          {
            interruptId: "stale",
            status: "resolved",
            payload: true,
          },
        ],
      },
      {
        onRunErrorEvent: ({ event }) => {
          errors.push(event.message);
        },
      },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/interrupt/i);
    expect(capturedPayload.value).toBeNull();
  });

  it.each([false, true])(
    "routes parallel answers by ID on reconnect (partial=%s)",
    async (partial) => {
      const { agent, capturedPayload } = buildPlatformAgent(["left", "right"]);
      const resume = [
        { interruptId: "right", status: "resolved" as const, payload: false },
        ...(partial
          ? []
          : [{ interruptId: "left", status: "resolved" as const, payload: 0 }]),
      ];
      await agent.runAgent({ resume });
      expect(capturedPayload.value?.command).toEqual({
        resume: partial ? { right: false } : { right: false, left: 0 },
      });
    },
  );
});
