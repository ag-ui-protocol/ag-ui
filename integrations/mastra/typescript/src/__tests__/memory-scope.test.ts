import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Interrupt } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MockMemory } from "@mastra/core/memory";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { z } from "zod";
import { MastraAgent } from "../mastra";
import {
  FakeLocalAgent,
  FakeMemory,
  FakeRemoteAgent,
  collectEvents,
  makeInput,
} from "./helpers";

// @mastra/core logs this from Agent#execute when a run is given a thread and
// a resource but the agent has no own memory. The text is stable from the
// 1.29 peer floor through 1.63 (the version the bug was reported on).
const MEMORY_WARNING =
  /No memory (is )?configured but resourceId and threadId were passed/;

const FRONTEND_TOOL = {
  name: "show_expense_card",
  description: "Renders the expense decision card in the UI",
  parameters: {
    type: "object",
    properties: { amount: { type: "number" } },
    required: ["amount"],
  },
};

const CONTEXT = [{ description: "tier", value: "premium" }];

const TRACING = { traceId: "trace-memory", metadata: { source: "ui" } };

function textModel() {
  return new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "t", delta: "Hi" });
          controller.enqueue({
            type: "finish",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            finishReason: "stop",
          });
          controller.close();
        },
      }),
      request: { body: {} },
      response: undefined,
    }),
  });
}

function approvalModel() {
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: unknown }) => {
      const answered =
        Array.isArray(prompt) && prompt.some((m: any) => m?.role === "tool");
      const chunks = answered
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Done." },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "stop",
            },
          ]
        : [
            {
              type: "tool-call",
              toolCallId: "tc-real",
              toolName: "record_expense",
              input: JSON.stringify({ amount: 250 }),
            },
            {
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "tool-calls",
            },
          ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        request: { body: {} },
        response: undefined,
      };
    },
  });
}

function coreAgent(
  opts: { memory?: unknown; tools?: Record<string, unknown> } = {},
) {
  return new Agent({
    id: "scope-agent",
    name: "scope-agent",
    instructions: "Answer briefly.",
    model: textModel() as any,
    ...(opts.memory !== undefined ? { memory: opts.memory as any } : {}),
    ...(opts.tools ? { tools: opts.tools as any } : {}),
  });
}

function wrap(
  agent: unknown,
  config: Record<string, unknown> = {},
) {
  return new MastraAgent({
    agentId: "scope-agent",
    agent: agent as any,
    resourceId: "resource-1",
    tracingOptions: TRACING,
    ...config,
  } as any);
}

function turn(overrides: Record<string, unknown> = {}) {
  return makeInput({
    messages: [{ id: "u1", role: "user", content: "Hi" }] as any,
    tools: [FRONTEND_TOOL] as any,
    context: CONTEXT as any,
    ...overrides,
  });
}

/** Records logger.warn on the agent core actually calls, including children. */
function attachWarnSpy(agent: object) {
  const warn = vi.fn();
  const logger = {
    level: "debug",
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    trackException: vi.fn(),
    child() {
      return logger;
    },
  };
  // `logger` is protected on the Agent type and public at runtime.
  const target = agent as unknown as {
    logger: typeof logger;
    __setLogger?: (logger: unknown) => void;
  };
  if (typeof target.__setLogger === "function") target.__setLogger(logger);
  else target.logger = logger;
  return warn;
}

function memoryWarnings(warn: ReturnType<typeof vi.fn>) {
  return warn.mock.calls.filter((args) =>
    args.some(
      (arg) => typeof arg === "string" && MEMORY_WARNING.test(arg),
    ),
  );
}

function spyCore(agent: Agent) {
  const streams: any[] = [];
  const resumes: any[] = [];
  const approvals: Array<{ approved: boolean; opts: any }> = [];
  const stream = agent.stream.bind(agent);
  const resumeStream = agent.resumeStream.bind(agent);
  const approveToolCall = agent.approveToolCall.bind(agent);
  const declineToolCall = agent.declineToolCall.bind(agent);
  vi.spyOn(agent, "stream").mockImplementation((async (
    messages: any,
    opts: any,
  ) => {
    streams.push(opts);
    return stream(messages, opts);
  }) as any);
  vi.spyOn(agent, "resumeStream").mockImplementation((async (
    data: any,
    opts: any,
  ) => {
    resumes.push(opts);
    return resumeStream(data, opts);
  }) as any);
  vi.spyOn(agent, "approveToolCall").mockImplementation((async (opts: any) => {
    approvals.push({ approved: true, opts });
    return approveToolCall(opts);
  }) as any);
  vi.spyOn(agent, "declineToolCall").mockImplementation((async (opts: any) => {
    approvals.push({ approved: false, opts });
    return declineToolCall(opts);
  }) as any);
  return { streams, resumes, approvals };
}

const EXPECTED_CLIENT_TOOL = {
  [FRONTEND_TOOL.name]: {
    id: FRONTEND_TOOL.name,
    description: FRONTEND_TOOL.description,
    inputSchema: FRONTEND_TOOL.parameters,
  },
};

function expectScope(
  opts: any,
  resource = "resource-1",
  thread = "thread-1",
) {
  expect(opts.memory).toEqual({ thread, resource });
}

function expectNoMemoryKey(opts: any) {
  expect(opts).toBeTruthy();
  expect("memory" in opts).toBe(false);
}

function expectRunCorrelation(opts: any, runId: string) {
  expect(opts.runId).toBe(runId);
  expect(opts.clientTools).toEqual(EXPECTED_CLIENT_TOOL);
  expect(opts.tracingOptions).toEqual(TRACING);
  expect(opts.requestContext.get("ag-ui").context).toEqual(CONTEXT);
  expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
}

function outcomeInterrupts(events: BaseEvent[]): Interrupt[] {
  const finished = events[events.length - 1] as any;
  expect(finished.type).toBe(EventType.RUN_FINISHED);
  return finished.outcome?.interrupts ?? [];
}

const APPROVAL_SCHEMA = JSON.stringify({
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
});

/** Real agents have listTools; the fake otherwise trips A2UI planning. */
function withListTools(fake: FakeLocalAgent) {
  (fake as FakeLocalAgent & { listTools: () => Promise<Record<string, never>> }).listTools =
    async () => ({});
  return fake;
}

function approvalChunks() {
  return [
    {
      type: "tool-call",
      runId: "mastra-run-1",
      payload: {
        toolCallId: "tc-1",
        toolName: "record_expense",
        args: { amount: 250 },
      },
    },
    {
      type: "tool-call-approval",
      runId: "mastra-run-1",
      payload: {
        toolCallId: "tc-1",
        toolName: "record_expense",
        args: { amount: 250 },
        resumeSchema: APPROVAL_SCHEMA,
      },
    },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local memory scope (#3123)", () => {
  describe("memory-less local agent", () => {
    it("omits memory on the initial stream and does not warn", async () => {
      const core = coreAgent();
      expect(core.hasOwnMemory()).toBe(false);
      const warn = attachWarnSpy(core);
      const { streams } = spyCore(core);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const events = await collectEvents(wrap(core), turn());

      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(streams).toHaveLength(1);
      expectNoMemoryKey(streams[0]);
      expectRunCorrelation(streams[0], "run-1");
      expect(memoryWarnings(warn)).toEqual([]);
      expect(
        consoleWarn.mock.calls.filter((args) =>
          args.some(
            (arg) => typeof arg === "string" && MEMORY_WARNING.test(arg),
          ),
        ),
      ).toEqual([]);
    });

    it("omits memory on resume, approve, and decline without dropping the snapshot key, tools, or tracing", async () => {
      const fake = withListTools(
        new FakeLocalAgent({
          ownsMemory: false,
          streamChunks: approvalChunks(),
          resumeChunks: [
            { type: "text-delta", payload: { text: "Done." } },
          ],
        }),
      );
      const agent = wrap(fake, { untilIdle: { maxIdleMs: 50 } });

      const first = await collectEvents(agent, turn());
      const [interrupt] = outcomeInterrupts(first);
      expectNoMemoryKey(fake.lastStreamOpts);
      expectRunCorrelation(fake.lastStreamOpts, "run-1");
      expect(fake.lastStreamOpts.untilIdle).toEqual({ maxIdleMs: 50 });

      await collectEvents(
        agent,
        turn({
          runId: "run-2",
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              payload: { approved: true },
            },
          ],
        }),
      );
      expect(fake.toolApprovalCalls).toEqual([
        { approved: true, opts: expect.any(Object) },
      ]);
      const approved = fake.toolApprovalCalls[0].opts;
      expectNoMemoryKey(approved);
      expect(approved.toolCallId).toBe("tc-1");
      expect(approved.runId).toBe("mastra-run-1");
      expectRunCorrelation(approved, "mastra-run-1");
      expect(approved.untilIdle).toEqual({ maxIdleMs: 50 });

      const declining = withListTools(
        new FakeLocalAgent({
          ownsMemory: false,
          streamChunks: approvalChunks(),
          resumeChunks: [
            { type: "text-delta", payload: { text: "Skipped." } },
          ],
        }),
      );
      const declineAgent = wrap(declining);
      const paused = outcomeInterrupts(
        await collectEvents(declineAgent, turn()),
      )[0];
      await collectEvents(
        declineAgent,
        turn({
          runId: "run-2",
          resume: [{ interruptId: paused.id, status: "cancelled" }],
        }),
      );
      expect(declining.toolApprovalCalls.map((call) => call.approved)).toEqual([
        false,
      ]);
      expectNoMemoryKey(declining.toolApprovalCalls[0].opts);
      expect(declining.toolApprovalCalls[0].opts).toMatchObject({
        toolCallId: "tc-1",
        runId: "mastra-run-1",
      });
      expect(declining.lastResumeOpts).toBe(
        declining.toolApprovalCalls[0].opts,
      );
    });

    it("does not warn on a real approve and decline of a memory-less agent", async () => {
      const execute = vi.fn(async (input: { amount: number }) => ({
        recordId: `expense-${input.amount}`,
      }));
      const tool = createTool({
        id: "record_expense",
        description: "Record an expense",
        inputSchema: z.object({ amount: z.number() }),
        requireApproval: true,
        execute,
      });
      const storage = new InMemoryStore();
      const core = new Agent({
        id: "approval-agent",
        name: "approval-agent",
        instructions: "Record expenses when asked.",
        model: approvalModel() as any,
        tools: { record_expense: tool },
      });
      expect(core.hasOwnMemory()).toBe(false);
      const mastra = new Mastra({
        agents: { approval: core },
        storage,
      });
      const registered = mastra.getAgent("approval");
      const warn = attachWarnSpy(registered);
      const { streams, approvals } = spyCore(registered);
      const agent = wrap(registered);

      const first = await collectEvents(
        agent,
        turn({
          messages: [
            { id: "u1", role: "user", content: "Record a $250 expense" },
          ],
          tools: [],
        }),
      );
      const [interrupt] = outcomeInterrupts(first);
      expect(interrupt.toolCallId).toBe("tc-real");
      expectNoMemoryKey(streams[0]);
      expect(streams[0].runId).toBe("run-1");
      expect(streams[0].abortSignal).toBeInstanceOf(AbortSignal);
      expect(streams[0].tracingOptions).toEqual(TRACING);

      const approved = await collectEvents(
        agent,
        turn({
          runId: "run-2",
          tools: [],
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              payload: { approved: true },
            },
          ],
        }),
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(approved.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(approvals).toHaveLength(1);
      expect(approvals[0].approved).toBe(true);
      expectNoMemoryKey(approvals[0].opts);
      // Approval ids are `mastra-approval::<snapshot runId>::<toolCallId>`.
      // The resumed call must keep that snapshot runId — it is the key Mastra
      // loads, and it is the runId the initial stream was given.
      expect(interrupt.id).toBe("mastra-approval::run-1::tc-real");
      expect(approvals[0].opts).toMatchObject({
        toolCallId: "tc-real",
        runId: "run-1",
      });
      expect(approvals[0].opts.tracingOptions).toEqual(TRACING);
      expect(approvals[0].opts.abortSignal).toBeInstanceOf(AbortSignal);

      const decliningCore = new Agent({
        id: "approval-agent",
        name: "approval-agent",
        instructions: "Record expenses when asked.",
        model: approvalModel() as any,
        tools: { record_expense: tool },
      });
      const decliningMastra = new Mastra({
        agents: { approval: decliningCore },
        storage: new InMemoryStore(),
      });
      const decliningRegistered = decliningMastra.getAgent("approval");
      const declineWarn = attachWarnSpy(decliningRegistered);
      const declineSpy = spyCore(decliningRegistered);
      const declineAgent = wrap(decliningRegistered);
      const paused = outcomeInterrupts(
        await collectEvents(
          declineAgent,
          turn({
            messages: [
              { id: "u1", role: "user", content: "Record a $250 expense" },
            ],
            tools: [],
          }),
        ),
      )[0];
      await collectEvents(
        declineAgent,
        turn({
          runId: "run-2",
          tools: [],
          resume: [{ interruptId: paused.id, status: "cancelled" }],
        }),
      );
      expect(declineSpy.approvals.map((call) => call.approved)).toEqual([
        false,
      ]);
      expectNoMemoryKey(declineSpy.approvals[0].opts);
      expect(paused.id).toBe("mastra-approval::run-1::tc-real");
      expect(declineSpy.approvals[0].opts).toMatchObject({
        toolCallId: "tc-real",
        runId: "run-1",
      });

      expect(memoryWarnings(warn)).toEqual([]);
      expect(memoryWarnings(declineWarn)).toEqual([]);
    });

    it("leaves reserved request-context ids in place", async () => {
      // Those ids also scope a run, and on some core versions they are enough
      // to warn even when `memory` is omitted. Silencing that by deleting
      // them would change authorization and thread identity.
      const requestContext = new RequestContext();
      requestContext.set(MASTRA_THREAD_ID_KEY, "ctx-thread");
      requestContext.set(MASTRA_RESOURCE_ID_KEY, "ctx-resource");
      const core = coreAgent();
      const { streams } = spyCore(core);

      await collectEvents(wrap(core, { requestContext }), turn());

      expectNoMemoryKey(streams[0]);
      expect(requestContext.get(MASTRA_THREAD_ID_KEY)).toBe("ctx-thread");
      expect(requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe("ctx-resource");
      expect(streams[0].requestContext).toBe(requestContext);
    });
  });

  describe("own memory keeps the scope", () => {
    it("passes thread and resource for static memory, including the threadId fallback", async () => {
      const core = coreAgent({ memory: new MockMemory() });
      expect(core.hasOwnMemory()).toBe(true);
      const warn = attachWarnSpy(core);
      const { streams } = spyCore(core);

      const events = await collectEvents(wrap(core), turn());

      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expectScope(streams[0]);
      expectRunCorrelation(streams[0], "run-1");
      expect(memoryWarnings(warn)).toEqual([]);

      const fallback = coreAgent({ memory: new MockMemory() });
      const fallbackSpy = spyCore(fallback);
      await collectEvents(
        wrap(fallback, { resourceId: undefined }),
        turn({ threadId: "thread-xyz" }),
      );
      expectScope(fallbackSpy.streams[0], "thread-xyz", "thread-xyz");
    });

    it("passes the scope for function-based memory without treating the factory as absent", async () => {
      let factories = 0;
      const memory = new MockMemory();
      const core = coreAgent({
        memory: () => {
          factories += 1;
          return memory;
        },
      });
      expect(core.hasOwnMemory()).toBe(true);
      const warn = attachWarnSpy(core);
      const { streams } = spyCore(core);

      const events = await collectEvents(wrap(core), turn());

      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expectScope(streams[0]);
      expect(factories).toBeGreaterThan(0);
      expect(memoryWarnings(warn)).toEqual([]);
    });

    it("notices memory attached with __setMemory after the wrapper is constructed", async () => {
      const core = coreAgent();
      expect(core.hasOwnMemory()).toBe(false);
      const agent = wrap(core);
      core.__setMemory(new MockMemory() as any);
      expect(core.hasOwnMemory()).toBe(true);
      const { streams } = spyCore(core);

      await collectEvents(agent, turn());

      expectScope(streams[0]);
    });

    it("keeps the scope on resume when the agent has its own memory", async () => {
      const fake = withListTools(
        new FakeLocalAgent({
          streamChunks: approvalChunks(),
          resumeChunks: [{ type: "text-delta", payload: { text: "Done." } }],
        }),
      );
      expect(fake.hasOwnMemory()).toBe(true);
      const agent = wrap(fake);
      const [interrupt] = outcomeInterrupts(
        await collectEvents(agent, turn()),
      );

      await collectEvents(
        agent,
        turn({
          runId: "run-2",
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              payload: { approved: true },
            },
          ],
        }),
      );

      expectScope(fake.lastStreamOpts);
      expectScope(fake.toolApprovalCalls[0].opts);
      expect(fake.toolApprovalCalls[0].opts).toMatchObject({
        toolCallId: "tc-1",
        runId: "mastra-run-1",
      });
      expect(fake.toolApprovalCalls[0].opts.clientTools).toEqual(
        EXPECTED_CLIENT_TOOL,
      );
      expect(fake.toolApprovalCalls[0].opts.tracingOptions).toEqual(TRACING);
    });
  });

  describe("inherited request-context memory", () => {
    it("keeps the scope when getMemory resolves memory for this request and hasOwnMemory is false", async () => {
      // Newer cores inherit a supervisor's memory through the request context
      // while hasOwnMemory() stays false. The core warning keys off own memory,
      // so passing the scope can still warn — dropping it would run that
      // store with no thread. This is the preservation policy.
      const requestContext = new RequestContext();
      const inherited = new FakeMemory();
      requestContext.set("inherited-memory", inherited);
      const seen: unknown[] = [];
      const fake = withListTools(new FakeLocalAgent({ ownsMemory: false }));
      fake.getMemory = async (opts?: { requestContext?: RequestContext }) => {
        seen.push(opts?.requestContext);
        return opts?.requestContext?.get("inherited-memory") as
          | FakeMemory
          | undefined;
      };
      const agent = wrap(fake, { requestContext });

      await collectEvents(agent, turn());

      expect(fake.hasOwnMemory()).toBe(false);
      expectScope(fake.lastStreamOpts);
      expect(seen[0]).toBe(requestContext);
      expect(requestContext.get("inherited-memory")).toBe(inherited);
      expect(
        (requestContext.get("ag-ui") as { context: unknown }).context,
      ).toEqual(CONTEXT);
    });

    it("omits the scope when the same agent has no inherited memory for this request", async () => {
      const requestContext = new RequestContext();
      const fake = withListTools(new FakeLocalAgent({ ownsMemory: false }));
      fake.getMemory = async (opts?: { requestContext?: RequestContext }) =>
        opts?.requestContext?.get("inherited-memory") as FakeMemory | undefined;
      const agent = wrap(fake, { requestContext });

      await collectEvents(agent, turn());

      expectNoMemoryKey(fake.lastStreamOpts);
    });

    it("keeps the scope when getMemory throws and own memory is absent", async () => {
      const fake = withListTools(new FakeLocalAgent({ ownsMemory: false }));
      fake.getMemory = async () => {
        throw new Error("memory factory failed");
      };
      const agent = wrap(fake);
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const events = await collectEvents(agent, turn());

      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expectScope(fake.lastStreamOpts);
      expect(consoleWarn).toHaveBeenCalled();
    });
  });

  describe("agents that do not implement hasOwnMemory", () => {
    it("keeps the scope when getMemory still returns memory", async () => {
      const fake = withListTools(new FakeLocalAgent());
      delete (fake as { hasOwnMemory?: unknown }).hasOwnMemory;

      await collectEvents(wrap(fake), turn());

      expectScope(fake.lastStreamOpts);
    });

    it("omits the scope only when getMemory resolves empty", async () => {
      const fake = withListTools(new FakeLocalAgent({ ownsMemory: false }));
      delete (fake as { hasOwnMemory?: unknown }).hasOwnMemory;

      await collectEvents(wrap(fake), turn());

      expectNoMemoryKey(fake.lastStreamOpts);
    });
  });

  describe("remote agents", () => {
    it("still sends memory on the initial stream and on resume", async () => {
      const fake = new FakeRemoteAgent({
        streamChunks: [{ type: "finish", payload: {} }],
        resumeChunks: [{ type: "text-delta", payload: { text: "Done." } }],
      });
      const agent = wrap(fake);

      await collectEvents(agent, turn());
      expectScope(fake.lastStreamOpts);
      expect(fake.lastStreamOpts.runId).toBe("run-1");
      expect(fake.lastStreamOpts.clientTools).toEqual(EXPECTED_CLIENT_TOOL);
      expect(fake.lastStreamOpts.tracingOptions).toEqual(TRACING);
      expect("abortSignal" in fake.lastStreamOpts).toBe(false);

      await collectEvents(
        agent,
        turn({
          runId: "run-2",
          resume: [
            {
              interruptId: "remote-run::remote-tool",
              status: "resolved",
              payload: { approved: true },
            },
          ],
        }),
      );
      expect(fake.resumeCalls).toHaveLength(1);
      expectScope(fake.resumeCalls[0].opts);
      expect(fake.resumeCalls[0].opts).toMatchObject({
        toolCallId: "remote-tool",
        runId: "remote-run",
      });
      expect(fake.resumeCalls[0].opts.clientTools).toEqual(EXPECTED_CLIENT_TOOL);
      expect(fake.resumeCalls[0].opts.tracingOptions).toEqual(TRACING);
      expect("abortSignal" in fake.resumeCalls[0].opts).toBe(false);
    });
  });
});
