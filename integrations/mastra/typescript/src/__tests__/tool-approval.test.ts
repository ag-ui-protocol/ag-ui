import { describe, it, expect, vi } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Interrupt } from "@ag-ui/client";
import { RunFinishedEventSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { InMemoryStore } from "@mastra/core/storage";
import { MockMemory } from "@mastra/core/memory";
import { createTool } from "@mastra/core/tools";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { z } from "zod";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  makeInput,
  collectEvents,
  collectRunError,
} from "./helpers";
import { MastraAgent } from "../mastra";

// Mastra pauses a tool that needs approval (`requireApproval` on the tool, or
// `requireToolApproval` on the agent) with a `tool-call-approval` chunk, not
// `tool-call-suspended`. The pending call lives in Mastra's snapshot and is
// completed by Mastra's own approve / decline, keyed by the original runId and
// toolCallId.

const APPROVAL_SCHEMA = JSON.stringify({
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
});

function approvalChunks(toolCallId = "tc-1", runId = "mastra-run-1") {
  return [
    {
      type: "tool-call",
      runId,
      payload: {
        toolCallId,
        toolName: "record_expense",
        args: { amount: 250, description: "team dinner" },
      },
    },
    {
      type: "tool-call-approval",
      runId,
      payload: {
        toolCallId,
        toolName: "record_expense",
        args: { amount: 250, description: "team dinner" },
        resumeSchema: APPROVAL_SCHEMA,
      },
    },
  ];
}

// What Mastra streams after an approved call: the tool's real result (without
// re-emitting the tool-call) and the model's follow-up.
function approvedResumeChunks(toolCallId = "tc-1") {
  return [
    {
      type: "tool-result",
      payload: {
        toolCallId,
        toolName: "record_expense",
        args: { amount: 250, description: "team dinner" },
        result: { recorded: true, amount: 250 },
      },
    },
    { type: "text-delta", payload: { text: "Recorded the expense." } },
  ];
}

function makeLocal(opts: { streamChunks?: any[]; resumeChunks?: any[] } = {}) {
  const fake = new FakeLocalAgent(opts);
  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fake as any,
    resourceId: "resource-1",
  });
  return { agent, fake };
}

function makeRemote(opts: { streamChunks?: any[]; resumeChunks?: any[] } = {}) {
  const fake = new FakeRemoteAgent(opts);
  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fake as any,
    resourceId: "resource-1",
  });
  return { agent, fake };
}

function outcomeInterrupts(events: BaseEvent[]): Interrupt[] {
  const finished = events[events.length - 1] as any;
  expect(finished.type).toBe(EventType.RUN_FINISHED);
  return finished.outcome?.interrupts ?? [];
}

// Answers `interrupt` the way a client does: a decline as a cancelled entry,
// anything else as a resolved entry carrying the payload.
function resumeFor(interrupt: Interrupt, answer: unknown) {
  return makeInput({
    runId: "run-2",
    resume: [
      answer === false
        ? { interruptId: interrupt.id, status: "cancelled" }
        : { interruptId: interrupt.id, status: "resolved", payload: answer },
    ],
  } as any);
}

async function pausedInterrupt(agent: MastraAgent): Promise<Interrupt> {
  const [interrupt] = outcomeInterrupts(
    await collectEvents(agent, makeInput()),
  );
  return interrupt;
}

function toolEventsFor(events: BaseEvent[], toolCallId: string) {
  return events
    .filter(
      (e) =>
        [
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
        ].includes(e.type) && (e as any).toolCallId === toolCallId,
    )
    .map((e) => e.type);
}

describe("tool approval: pause surfaces an interrupt", () => {
  it("reports the pause only on RUN_FINISHED, with no CUSTOM event", async () => {
    const { agent } = makeLocal({ streamChunks: approvalChunks() });
    const events = await collectEvents(agent, makeInput({ runId: "agui-1" }));

    expect(events.some((e) => e.type === EventType.CUSTOM)).toBe(false);
    expect(outcomeInterrupts(events)).toHaveLength(1);
  });

  it("carries a canonical approval Interrupt on RUN_FINISHED.outcome", async () => {
    const { agent } = makeLocal({ streamChunks: approvalChunks() });
    const events = await collectEvents(agent, makeInput({ runId: "agui-1" }));

    const finished = events[events.length - 1];
    expect(RunFinishedEventSchema.safeParse(finished).success).toBe(true);
    const interrupts = outcomeInterrupts(events);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]).toMatchObject({
      reason: "mastra:tool_approval",
      toolCallId: "tc-1",
      responseSchema: JSON.parse(APPROVAL_SCHEMA),
      metadata: {
        mastra: {
          type: "mastra_tool_approval",
          toolName: "record_expense",
          args: { amount: 250, description: "team dinner" },
          resumeSchema: APPROVAL_SCHEMA,
          runId: "mastra-run-1",
        },
      },
    });
  });

  it("suppresses the buffered tool call so no call without a result is emitted", async () => {
    const { agent } = makeLocal({ streamChunks: approvalChunks() });
    const events = await collectEvents(agent, makeInput());

    expect(toolEventsFor(events, "tc-1")).toEqual([]);
  });

  it("closes a live-streamed server call instead of leaving it open", async () => {
    const fake = new FakeLocalAgent({
      streamChunks: [
        {
          type: "tool-call-input-streaming-start",
          payload: { toolCallId: "tc-1", toolName: "record_expense" },
        },
        {
          type: "tool-call-delta",
          payload: { toolCallId: "tc-1", argsTextDelta: '{"amount":250}' },
        },
        ...approvalChunks(),
      ],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
      streamServerToolCalls: true,
    });
    const events = await collectEvents(agent, makeInput());

    const types = toolEventsFor(events, "tc-1");
    expect(types[0]).toBe(EventType.TOOL_CALL_START);
    expect(types[types.length - 1]).toBe(EventType.TOOL_CALL_END);
    expect(types).not.toContain(EventType.TOOL_CALL_RESULT);
    expect(outcomeInterrupts(events)[0]?.metadata?.mastra?.type).toBe(
      "mastra_tool_approval",
    );
  });

  it("works the same for remote agents", async () => {
    const { agent } = makeRemote({ streamChunks: approvalChunks() });
    const events = await collectEvents(agent, makeInput());

    expect(outcomeInterrupts(events)[0]?.reason).toBe("mastra:tool_approval");
    expect(toolEventsFor(events, "tc-1")).toEqual([]);
  });

  it("errors on an approval chunk without a toolCallId", async () => {
    const { agent } = makeLocal({
      streamChunks: [
        {
          type: "tool-call-approval",
          payload: { toolName: "record_expense", args: {}, resumeSchema: "{}" },
        },
      ],
    });
    const { error } = await collectRunError(agent, makeInput());
    expect(error.message).toMatch(/tool-call-approval/);
  });
});

describe("tool approval: resume completes the original call natively", () => {
  it("approve calls Mastra's approveToolCall with the original runId and toolCallId", async () => {
    const { agent, fake } = makeLocal({
      streamChunks: approvalChunks(),
      resumeChunks: approvedResumeChunks(),
    });
    const interrupt = await pausedInterrupt(agent);
    fake.lastStreamOpts = null;

    await collectEvents(agent, resumeFor(interrupt, { approved: true }));

    expect(fake.toolApprovalCalls).toHaveLength(1);
    expect(fake.toolApprovalCalls[0].approved).toBe(true);
    expect(fake.toolApprovalCalls[0].opts).toMatchObject({
      runId: "mastra-run-1",
      toolCallId: "tc-1",
      memory: { thread: "thread-1", resource: "resource-1" },
    });
    // No fresh run: the paused call is completed, not re-requested.
    expect(fake.lastStreamOpts).toBeNull();
  });

  it("decline still goes to Mastra's declineToolCall", async () => {
    const { agent, fake } = makeLocal({
      streamChunks: approvalChunks(),
      resumeChunks: [
        {
          type: "tool-result",
          payload: {
            toolCallId: "tc-1",
            toolName: "record_expense",
            result: "Tool call was not approved by the user",
          },
        },
        { type: "text-delta", payload: { text: "Okay, not recorded." } },
      ],
    });
    const interrupt = await pausedInterrupt(agent);

    const events = await collectEvents(agent, resumeFor(interrupt, false));

    expect(fake.toolApprovalCalls).toEqual([
      {
        approved: false,
        opts: expect.objectContaining({
          runId: "mastra-run-1",
          toolCallId: "tc-1",
        }),
      },
    ]);
    const text = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;
    expect(text.delta).toBe("Okay, not recorded.");
  });

  it("an explicit { approved: false } payload declines", async () => {
    const { agent, fake } = makeLocal({ streamChunks: approvalChunks() });
    const interrupt = await pausedInterrupt(agent);

    await collectEvents(agent, resumeFor(interrupt, { approved: false }));

    expect(fake.toolApprovalCalls.map((c) => c.approved)).toEqual([false]);
  });

  it("approved resume emits START/ARGS/END for the original id before its RESULT", async () => {
    const { agent } = makeLocal({
      streamChunks: approvalChunks(),
      resumeChunks: approvedResumeChunks(),
    });
    const interrupt = await pausedInterrupt(agent);

    const events = await collectEvents(
      agent,
      resumeFor(interrupt, { approved: true }),
    );

    expect(toolEventsFor(events, "tc-1")).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    const start = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    expect(start.toolCallName).toBe("record_expense");
    const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS) as any;
    expect(JSON.parse(args.delta)).toEqual({
      amount: 250,
      description: "team dinner",
    });
    const result = events.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as any;
    expect(JSON.parse(result.content)).toEqual({ recorded: true, amount: 250 });
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("the canonical resume channel approves via the emitted interrupt id", async () => {
    const { agent, fake } = makeLocal({
      streamChunks: approvalChunks(),
      resumeChunks: approvedResumeChunks(),
    });
    const [interrupt] = outcomeInterrupts(
      await collectEvents(agent, makeInput()),
    );

    const events = await collectEvents(
      agent,
      makeInput({
        runId: "run-2",
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: { approved: true },
          },
        ],
      } as any),
    );

    expect(fake.toolApprovalCalls).toHaveLength(1);
    expect(fake.toolApprovalCalls[0]).toMatchObject({
      approved: true,
      opts: { runId: "mastra-run-1", toolCallId: "tc-1" },
    });
    expect(toolEventsFor(events, "tc-1")).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
  });

  it("a cancelled canonical entry declines through Mastra", async () => {
    const { agent, fake } = makeLocal({ streamChunks: approvalChunks() });
    const [interrupt] = outcomeInterrupts(
      await collectEvents(agent, makeInput()),
    );

    await collectEvents(
      agent,
      makeInput({
        runId: "run-2",
        resume: [
          { interruptId: interrupt.id, status: "cancelled", payload: null },
        ],
      } as any),
    );

    expect(fake.toolApprovalCalls).toHaveLength(1);
    expect(fake.toolApprovalCalls[0]).toMatchObject({
      approved: false,
      opts: { runId: "mastra-run-1", toolCallId: "tc-1" },
    });
  });

  it("remote approve resumes the original call with { approved: true }", async () => {
    const { agent, fake } = makeRemote({
      streamChunks: approvalChunks(),
      resumeChunks: approvedResumeChunks(),
    });
    const interrupt = await pausedInterrupt(agent);

    const events = await collectEvents(
      agent,
      resumeFor(interrupt, { approved: true }),
    );

    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.resumeCalls[0].resumeData).toEqual({ approved: true });
    expect(fake.resumeCalls[0].opts).toMatchObject({
      runId: "mastra-run-1",
      toolCallId: "tc-1",
    });
    expect(toolEventsFor(events, "tc-1")).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
  });

  it("remote decline resumes the original call with { approved: false }", async () => {
    const { agent, fake } = makeRemote({
      streamChunks: approvalChunks(),
      resumeChunks: [],
    });
    const interrupt = await pausedInterrupt(agent);

    await collectEvents(agent, resumeFor(interrupt, false));

    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.resumeCalls[0].resumeData).toEqual({ approved: false });
    expect(fake.resumeCalls[0].opts).toMatchObject({
      runId: "mastra-run-1",
      toolCallId: "tc-1",
    });
  });
});

// Only `true`, `{ approved: boolean }` or a cancelled entry answers an
// approval. Anything else fails the run before any Mastra call, so a client bug
// cannot silently decline a call nobody declined.
function spyOnMastraCalls(fake: FakeLocalAgent) {
  return [
    vi.spyOn(fake, "approveToolCall"),
    vi.spyOn(fake, "declineToolCall"),
    vi.spyOn(fake, "resumeStream"),
    vi.spyOn(fake, "stream"),
  ];
}

function expectInvalidApproval(error: Error, events: BaseEvent[]) {
  expect(events.map((e) => e.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.RUN_ERROR,
  ]);
  expect(error.name).toBe("ResumeRequestError");
  expect((error as any).code).toBe("MASTRA_INVALID_TOOL_APPROVAL");
  expect(error.message).toContain("tc-1");
  expect(events[1]).toEqual({
    type: EventType.RUN_ERROR,
    message: error.message,
    code: "MASTRA_INVALID_TOOL_APPROVAL",
  });
}

const MALFORMED_ANSWERS = [
  ["null", null],
  ["{}", {}],
  ["{ approve: true }", { approve: true }],
  ['{ approved: "yes" }', { approved: "yes" }],
  ["a string", "ok"],
] as const;

describe("tool approval: a malformed answer fails the run without calling Mastra", () => {
  it.each([["no payload", undefined], ...MALFORMED_ANSWERS] as const)(
    "a canonical resolved entry with %s",
    async (_label, payload) => {
      const { agent, fake } = makeLocal({ streamChunks: approvalChunks() });
      const [interrupt] = outcomeInterrupts(
        await collectEvents(agent, makeInput()),
      );
      const spies = spyOnMastraCalls(fake);

      const { error, events } = await collectRunError(
        agent,
        makeInput({
          runId: "run-2",
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              ...(payload === undefined ? {} : { payload }),
            },
          ],
        } as any),
      );

      expectInvalidApproval(error, events);
      expect(error.message).toContain(interrupt.id);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(fake.toolApprovalCalls).toHaveLength(0);
    },
  );

  it("a remote agent is not resumed either", async () => {
    const { agent, fake } = makeRemote({
      streamChunks: approvalChunks(),
      resumeChunks: approvedResumeChunks(),
    });
    const [interrupt] = outcomeInterrupts(
      await collectEvents(agent, makeInput()),
    );
    const streamSpy = vi.spyOn(fake, "stream");

    const { error, events } = await collectRunError(
      agent,
      makeInput({
        runId: "run-2",
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: { approve: true },
          },
        ],
      } as any),
    );

    expectInvalidApproval(error, events);
    expect(fake.resumeCalls).toHaveLength(0);
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

describe("tool approval: ordinary suspend is unchanged", () => {
  it("a cancelled entry for a suspend closes the run without calling Mastra", async () => {
    const { agent, fake } = makeLocal({ streamChunks: [] });
    const resumeSpy = vi.spyOn(fake, "resumeStream");

    const events = await collectEvents(
      agent,
      makeInput({
        runId: "run-2",
        resume: [{ interruptId: "r::tc-1", status: "cancelled" }],
      } as any),
    );

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(fake.toolApprovalCalls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("a frontend tool call still streams as a tool call with no interrupt", async () => {
    const { agent } = makeLocal({
      streamChunks: [
        {
          type: "tool-call-input-streaming-start",
          payload: { toolCallId: "tc-ui", toolName: "confirm_expense" },
        },
        {
          type: "tool-call-delta",
          payload: { toolCallId: "tc-ui", argsTextDelta: '{"amount":250}' },
        },
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-ui",
            toolName: "confirm_expense",
            args: { amount: 250 },
          },
        },
      ],
    });

    const events = await collectEvents(
      agent,
      makeInput({
        tools: [
          {
            name: "confirm_expense",
            description: "Ask the user to confirm",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(toolEventsFor(events, "tc-ui")).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    expect(outcomeInterrupts(events)).toEqual([]);
  });
  it("a canonical suspend resume passes any payload to resumeStream unchanged", async () => {
    const { agent, fake } = makeLocal({ streamChunks: [] });
    const resumeSpy = vi.spyOn(fake, "resumeStream");

    await collectEvents(
      agent,
      makeInput({
        runId: "run-2",
        resume: [{ interruptId: "r::tc-1", status: "resolved", payload: "ok" }],
      } as any),
    );

    expect(fake.toolApprovalCalls).toHaveLength(0);
    expect(resumeSpy).toHaveBeenCalledWith(
      "ok",
      expect.objectContaining({ runId: "r", toolCallId: "tc-1" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Real @mastra/core round trip: a genuine pending approval in Mastra storage,
// completed through the adapter. The model stand-in answers from the prompt it
// is given, so the follow-up only appears once the real tool result is in it.
// ---------------------------------------------------------------------------

function promptHasToolResult(prompt: unknown): boolean {
  return Array.isArray(prompt) && prompt.some((m: any) => m?.role === "tool");
}

function approvalModel() {
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: unknown }) => {
      const chunks = promptHasToolResult(prompt)
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "All done." },
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

function realApprovalAgent(level: "tool" | "agent") {
  const execute = vi.fn(async (input: { amount: number }) => ({
    recordId: `expense-${input.amount}`,
    amount: input.amount,
  }));
  const tool = createTool({
    id: "record_expense",
    description: "Record an expense",
    inputSchema: z.object({ amount: z.number() }),
    ...(level === "tool" ? { requireApproval: true } : {}),
    execute,
  });
  // One store for both the thread messages and the workflow snapshots, so a
  // test can read everything Mastra persisted from a single place.
  const storage = new InMemoryStore();
  const mastraAgent = new Agent({
    id: "approval-agent",
    name: "approval-agent",
    instructions: "Record expenses when asked.",
    model: approvalModel() as any,
    tools: { record_expense: tool },
    memory: new MockMemory({ storage }) as any,
    ...(level === "agent"
      ? { defaultOptions: { requireToolApproval: true } }
      : {}),
  });
  const mastra = new Mastra({
    agents: { approval: mastraAgent },
    storage,
    logger: false,
  });
  const agent = new MastraAgent({
    agentId: "approval",
    agent: mastra.getAgent("approval") as any,
    resourceId: "resource-1",
  });
  return { agent, execute, storage };
}

const userTurn = makeInput({
  runId: "run-1",
  messages: [{ id: "u1", role: "user", content: "Record a $250 expense" }],
});

function snapshotStatus(snapshot: unknown): unknown {
  const value =
    typeof snapshot === "string" ? JSON.parse(snapshot) : (snapshot as any);
  return value?.status;
}

// What Mastra has persisted for a paused approval: the workflow runs still
// suspended under the snapshot runId, and the stored tool invocation.
async function storedApproval(
  storage: InMemoryStore,
  runId: string,
  toolCallId: string,
) {
  const workflows = await storage.getStore("workflows");
  const { runs } = await workflows!.listWorkflowRuns();
  const suspendedRuns = runs
    .filter(
      (run) =>
        run.runId === runId && snapshotStatus(run.snapshot) === "suspended",
    )
    .map((run) => run.workflowName);

  const memory = await storage.getStore("memory");
  const { messages } = await memory!.listMessages({ threadId: "thread-1" });
  const invocation = messages
    .flatMap((message) => message.content.parts ?? [])
    .flatMap((part) => (part.type === "tool-invocation" ? [part] : []))
    .map((part) => part.toolInvocation)
    .find((inv) => inv.toolCallId === toolCallId);

  return { suspendedRuns, invocation };
}

// A decline must leave no pending approval behind: the tool never ran, the
// original call got Mastra's decline result, the snapshot is no longer
// suspended, and the stored invocation is settled rather than still a `call`.
async function expectDeclinedAndCleared(
  resumed: BaseEvent[],
  storage: InMemoryStore,
  execute: ReturnType<typeof vi.fn>,
) {
  expect(execute).not.toHaveBeenCalled();

  const results = resumed.filter(
    (e) => e.type === EventType.TOOL_CALL_RESULT,
  ) as any[];
  expect(results).toHaveLength(1);
  expect(results[0].toolCallId).toBe("tc-real");
  const declineResult = JSON.parse(results[0].content);
  expect(declineResult).toMatch(/not approved/);
  expect(outcomeInterrupts(resumed)).toEqual([]);

  const stored = await storedApproval(storage, "run-1", "tc-real");
  expect(stored.suspendedRuns).toEqual([]);
  expect(stored.invocation).toMatchObject({
    state: "result",
    result: declineResult,
  });
}

async function pauseForApproval(level: "tool" | "agent") {
  const setup = realApprovalAgent(level);
  const first = await collectEvents(setup.agent, userTurn);
  expect(setup.execute).not.toHaveBeenCalled();

  // Guard against a vacuous "cleared" check: the pause is really persisted.
  const stored = await storedApproval(setup.storage, "run-1", "tc-real");
  expect(stored.suspendedRuns).not.toEqual([]);
  expect(stored.invocation).toMatchObject({ state: "call" });

  return { ...setup, first };
}

function canonicalResume(entry: Record<string, unknown>) {
  return makeInput({ runId: "run-2", resume: [entry] } as any);
}

describe.each(["tool", "agent"] as const)(
  "tool approval: real @mastra/core round trip (%s-level approval)",
  (level) => {
    it("pauses with an interrupt, then approve executes the original call", async () => {
      const { agent, execute } = realApprovalAgent(level);

      const first = await collectEvents(agent, userTurn);
      expect(execute).not.toHaveBeenCalled();
      const [interrupt] = outcomeInterrupts(first);
      expect(interrupt).toMatchObject({
        reason: "mastra:tool_approval",
        toolCallId: "tc-real",
      });

      const resumed = await collectEvents(
        agent,
        makeInput({
          runId: "run-2",
          resume: [
            {
              interruptId: interrupt.id,
              status: "resolved",
              payload: { approved: true },
            },
          ],
        } as any),
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toEqual({ amount: 250 });
      expect(toolEventsFor(resumed, "tc-real")).toEqual([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
      ]);
      const result = resumed.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      ) as any;
      expect(JSON.parse(result.content)).toEqual({
        recordId: "expense-250",
        amount: 250,
      });
      const text = resumed
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
        .map((e: any) => e.delta)
        .join("");
      expect(text).toBe("All done.");
      expect(resumed[resumed.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("decline resolves the pending approval in Mastra without executing", async () => {
      const { agent, execute, storage, first } = await pauseForApproval(level);
      const [interrupt] = outcomeInterrupts(first);

      const resumed = await collectEvents(agent, resumeFor(interrupt, false));

      await expectDeclinedAndCleared(resumed, storage, execute);
      const text = resumed
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
        .map((e: any) => e.delta)
        .join("");
      expect(text).toBe("All done.");
    });

    it.each([
      ["resolved with { approved: false }", "resolved", { approved: false }],
      ["cancelled without a payload", "cancelled", undefined],
      // The status decides: a cancelled entry declines whatever it carries.
      ["cancelled with an approving payload", "cancelled", { approved: true }],
    ] as const)(
      "a canonical entry %s declines and clears the pending approval",
      async (_label, status, payload) => {
        const { agent, execute, storage, first } =
          await pauseForApproval(level);
        const [interrupt] = outcomeInterrupts(first);

        const resumed = await collectEvents(
          agent,
          canonicalResume({
            interruptId: interrupt.id,
            status,
            ...(payload === undefined ? {} : { payload }),
          }),
        );

        await expectDeclinedAndCleared(resumed, storage, execute);
        expect(resumed[resumed.length - 1].type).toBe(EventType.RUN_FINISHED);
      },
    );
    it("a malformed answer fails the run and leaves the approval answerable", async () => {
      const { agent, execute, storage, first } = await pauseForApproval(level);
      const [interrupt] = outcomeInterrupts(first);

      const { error } = await collectRunError(
        agent,
        canonicalResume({
          interruptId: interrupt.id,
          status: "resolved",
          payload: { approve: true },
        }),
      );

      expect((error as any).code).toBe("MASTRA_INVALID_TOOL_APPROVAL");
      expect(execute).not.toHaveBeenCalled();
      const stored = await storedApproval(storage, "run-1", "tc-real");
      expect(stored.suspendedRuns).not.toEqual([]);
      expect(stored.invocation).toMatchObject({ state: "call" });

      const resumed = await collectEvents(
        agent,
        canonicalResume({
          interruptId: interrupt.id,
          status: "resolved",
          payload: { approved: true },
        }),
      );

      expect(execute).toHaveBeenCalledTimes(1);
      const results = resumed.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      ) as any[];
      expect(results).toHaveLength(1);
      expect(results[0].toolCallId).toBe("tc-real");
      expect(JSON.parse(results[0].content)).toEqual({
        recordId: "expense-250",
        amount: 250,
      });
      expect(resumed[resumed.length - 1].type).toBe(EventType.RUN_FINISHED);
    });
  },
);
