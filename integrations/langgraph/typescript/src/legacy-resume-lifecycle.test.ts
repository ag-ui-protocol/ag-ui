import { describe, it, expect, vi, afterEach } from "vitest";
import { LangGraphAgent } from "./agent";
import { LangGraphHttpAgent } from "./index";

/** Legacy forwardedProps.command.resume must not bypass the canonical resume validation or clear pending interrupts, for either platform or HTTP agents. */
function buildPlatformAgent() {
  const capturedPayload: { value: Record<string, unknown> | null } = {
    value: null,
  };
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });

  const interruptState = {
    values: { messages: [] },
    tasks: [{ interrupts: [{ value: { reason: "confirm" }, id: "int-1" }] }],
    next: ["process_steps_node"],
    metadata: {},
  };

  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue(interruptState),
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
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => ({ done: true, value: undefined }) };
            },
          };
        }),
    },
  };

  return { agent, capturedPayload };
}

describe("legacy command.resume after interrupt-outcome run", () => {
  afterEach(() => vi.restoreAllMocks());

  it("first run records pendingInterrupts (new structured-interrupt behavior)", async () => {
    const { agent } = buildPlatformAgent();
    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1"]);
  });

  it("rejects legacy resume without clearing pending interrupts", async () => {
    const { agent, capturedPayload } = buildPlatformAgent();

    // 1st run: pending interrupt -> RUN_FINISHED outcome=interrupt
    await agent.runAgent({ runId: "run-1" } as any);
    expect(agent.pendingInterrupts.length).toBe(1);

    // A legacy directive cannot satisfy the pending interrupt.
    await expect(
      agent.runAgent({
        runId: "run-2",
        forwardedProps: { command: { resume: "user picked: a, b" } },
      } as any),
    ).rejects.toThrow(/pending interrupt/i);

    expect(capturedPayload.value).toBeNull();
    expect(agent.pendingInterrupts).toHaveLength(1);
  });

  it("LangGraphHttpAgent rejects legacy resume with pending interrupts", async () => {
    const requests: any[] = [];
    const agent = new LangGraphHttpAgent({
      url: "http://localhost:8000",
      // Answers the resume run with an empty successful run, so no server is needed.
      fetch: async (_url: string, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body));
        requests.push(input);
        const events = [
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    (agent as any).pendingInterrupts = [{ id: "int-1", reason: "confirm" }];

    // The approval goes through runAgent(), which runs the resume check after
    // canonical validation checks the tracked interrupts.
    await expect(
      agent.runAgent({
        runId: "run-2",
        forwardedProps: { command: { resume: "yes" } },
      }),
    ).rejects.toThrow(/pending interrupt/i);
    expect(requests).toHaveLength(0);
    expect(agent.pendingInterrupts).toHaveLength(1);
  });

  it("still rejects a normal (non-resume) run while interrupts are pending", async () => {
    const agent = new LangGraphHttpAgent({ url: "http://localhost:8000" });
    (agent as any).pendingInterrupts = [{ id: "int-1", reason: "confirm" }];

    // The guard applies to runs only, and rejects before any HTTP request.
    await expect(
      agent.runAgent({ runId: "run-2", forwardedProps: {} }),
    ).rejects.toThrow(/pending interrupt/i);
  });
});
