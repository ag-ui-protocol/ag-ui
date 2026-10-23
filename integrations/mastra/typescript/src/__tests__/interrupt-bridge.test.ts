import { vi } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Interrupt } from "@ag-ui/client";
import { RunFinishedEventSchema } from "@ag-ui/core/schemas";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  FakeMemory,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  collectRunError,
} from "./helpers";
import { MastraAgent } from "../mastra";

// ---------------------------------------------------------------------------
// Shared chunk fixtures
// ---------------------------------------------------------------------------

function makeSuspendChunks(toolCallId = "tc-1", toolName = "process-expense") {
  return [
    {
      type: "tool-call",
      payload: {
        toolCallId,
        toolName,
        args: { amount: 250, description: "team dinner" },
      },
    },
    {
      type: "tool-call-suspended",
      payload: {
        toolCallId,
        toolName,
        suspendPayload: { reason: "Amount exceeds $100" },
        args: { amount: 250, description: "team dinner" },
        resumeSchema:
          '{"type":"object","properties":{"approved":{"type":"boolean"}}}',
      },
    },
  ];
}

// Answers the interrupt this bridge emits for suspended call `toolCallId` of
// Mastra run `runId` (its id is `${runId}::${toolCallId}`), as a client does.
function makeResumeInput(
  suspended: { toolCallId: string; runId: string },
  payload: unknown = { approved: true },
) {
  return makeInput({
    resume: [
      {
        interruptId: `${suspended.runId}::${suspended.toolCallId}`,
        status: "resolved",
        payload,
      },
    ],
  } as any);
}

function makeDeclineInput(suspended: { toolCallId: string; runId: string }) {
  return makeInput({
    resume: [
      {
        interruptId: `${suspended.runId}::${suspended.toolCallId}`,
        status: "cancelled",
      },
    ],
  } as any);
}

/** The interrupts on a run's RUN_FINISHED outcome (empty when it has none). */
function interruptsOf(events: BaseEvent[]): Interrupt[] {
  const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as any;
  return finished?.outcome?.type === "interrupt"
    ? finished.outcome.interrupts
    : [];
}

function makeFakeLocalAgentWithResumeStream(resumeChunks: any[]) {
  const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
  const calls: Array<{ resumeData: any; opts: any }> = [];

  (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
    calls.push({ resumeData, opts });
    return {
      fullStream: (async function* () {
        for (const chunk of resumeChunks) yield chunk;
      })(),
    };
  };

  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });

  return { agent, fakeAgent, calls };
}

// Remote analogue: the FakeRemoteAgent replays resumeChunks through
// resumeStream's processDataStream (callback-based), matching @mastra/client-js.
function makeFakeRemoteAgentWithResumeStream(resumeChunks: any[]) {
  const fakeAgent = new FakeRemoteAgent({ streamChunks: [], resumeChunks });
  const agent = new MastraAgent({
    agentId: "test-agent",
    agent: fakeAgent as any,
    resourceId: "resource-1",
  });
  return { agent, fakeAgent, calls: fakeAgent.resumeCalls };
}

// ---------------------------------------------------------------------------
// Emit path
// ---------------------------------------------------------------------------

describe("interrupt bridge: emit path", () => {
  describe("tool-call-suspended → RUN_FINISHED interrupt outcome", () => {
    it("emits exactly RUN_STARTED, RUN_FINISHED, with no TOOL_CALL or CUSTOM events", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: makeSuspendChunks() });
      const events = await collectEvents(agent, makeInput());

      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
      ]);
      expect(interruptsOf(events)).toHaveLength(1);
    });

    it("works identically for remote agents", async () => {
      const localEvents = await collectEvents(
        makeLocalMastraAgent({ streamChunks: makeSuspendChunks() }),
        makeInput(),
      );
      const remoteEvents = await collectEvents(
        makeRemoteMastraAgent({ streamChunks: makeSuspendChunks() }),
        makeInput(),
      );

      expect(localEvents.map((e) => e.type)).toEqual(
        remoteEvents.map((e) => e.type),
      );
      expect(interruptsOf(remoteEvents)).toEqual(interruptsOf(localEvents));
    });
  });

  describe("tool-call-suspended WITHOUT preceding tool-call", () => {
    it("emits interrupt even when no tool-call chunk precedes it", async () => {
      // Defensive: handle tool-call-suspended even without a preceding tool-call chunk
      const agent = makeLocalMastraAgent({
        streamChunks: [
          {
            type: "tool-call-suspended",
            payload: {
              toolCallId: "tc-orphan",
              toolName: "orphan-tool",
              suspendPayload: {},
              args: {},
              resumeSchema: "{}",
            },
          },
        ],
      });

      const events = await collectEvents(agent, makeInput());
      const interrupts = interruptsOf(events);
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0].toolCallId).toBe("tc-orphan");
    });
  });
});

// ---------------------------------------------------------------------------
// Interrupt outcome
// ---------------------------------------------------------------------------

describe("interrupt bridge: RUN_FINISHED interrupt outcome", () => {
  it("emits RUN_FINISHED with outcome={type:'interrupt', interrupts:[...]}", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: makeSuspendChunks() });
    const events = await collectEvents(agent, makeInput());

    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;
    expect(finished.outcome).toBeDefined();
    expect(finished.outcome.type).toBe("interrupt");
    expect(finished.outcome.interrupts).toHaveLength(1);
  });

  it("maps the suspend payload to a valid Interrupt (round-trip fields preserved)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: makeSuspendChunks("tc-1", "process-expense"),
    });
    const events = await collectEvents(agent, makeInput({ runId: "run-42" }));

    const [interrupt] = interruptsOf(events) as any[];

    // id encodes the snapshot runId + tool call id (`${runId}::${toolCallId}`)
    // so a client round-trips the runId back via interruptId.
    expect(interrupt.id).toBe("run-42::tc-1");
    expect(interrupt.toolCallId).toBe("tc-1");
    expect(interrupt.reason).toBe("mastra:tool_suspend");
    // resumeSchema (a JSON string) is parsed into responseSchema.
    expect(interrupt.responseSchema).toEqual({
      type: "object",
      properties: { approved: { type: "boolean" } },
    });
    // The Mastra-specific payload a renderer reads lives under metadata.mastra.
    expect(interrupt.metadata.mastra).toMatchObject({
      type: "mastra_suspend",
      toolName: "process-expense",
      suspendPayload: { reason: "Amount exceeds $100" },
      args: { amount: 250, description: "team dinner" },
      runId: "run-42",
    });
  });

  it("surfaces a string suspendPayload.message as Interrupt.message", async () => {
    const [toolCall, suspended] = makeSuspendChunks();
    const agent = makeLocalMastraAgent({
      streamChunks: [
        toolCall,
        {
          ...suspended,
          payload: {
            ...suspended.payload,
            suspendPayload: { message: "Approve this expense?" },
          },
        },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    expect(interruptsOf(events)[0].message).toBe("Approve this expense?");
  });

  it("omits Interrupt.message when the suspendPayload has no string message", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: makeSuspendChunks() });
    const events = await collectEvents(agent, makeInput());

    expect("message" in interruptsOf(events)[0]).toBe(false);
  });

  it("validates against the canonical RunFinishedEventSchema", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: makeSuspendChunks() });
    const events = await collectEvents(agent, makeInput());
    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;

    // The emitted event must parse cleanly through the protocol schema:
    // proves the outcome shape is wire-valid, not just structurally similar.
    expect(() => RunFinishedEventSchema.parse(finished)).not.toThrow();
  });

  it("carries the snapshot-keying runId from the suspend chunk, not RunAgentInput.runId", async () => {
    // Mastra keys the suspended snapshot by the runId on the SUSPEND CHUNK,
    // which can differ from RunAgentInput.runId. The interrupt must carry the
    // chunk's runId so resume round-trips the right id.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-1",
            toolName: "t",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
            runId: "mastra-internal-run",
          },
        },
      ],
    });
    const events = await collectEvents(agent, makeInput({ runId: "agui-run" }));

    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;
    // Top-level RUN_FINISHED.runId stays the AG-UI run id.
    expect(finished.runId).toBe("agui-run");
    const [interrupt] = interruptsOf(events) as any[];
    expect(interrupt.id).toBe("mastra-internal-run::tc-1");
    expect(interrupt.metadata.mastra.runId).toBe("mastra-internal-run");
  });

  it("carries a chunk-level runId when the suspend payload has none", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          // chunk-level runId (BaseChunkType) is Mastra's actual run id.
          runId: "mastra-workflow-run-xyz",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: { topic: "Sync" },
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });
    const events = await collectEvents(
      agent,
      makeInput({ runId: "agui-run-1" }),
    );

    expect(interruptsOf(events)[0].id).toBe(
      "mastra-workflow-run-xyz::tc-sched",
    );
  });

  it("falls back to the AG-UI runId when the suspend chunk omits a runId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });
    const events = await collectEvents(
      agent,
      makeInput({ runId: "agui-run-2" }),
    );

    expect(interruptsOf(events)[0].id).toBe("agui-run-2::tc-sched");
  });

  it("reports only the first of several suspends, warning about the rest", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chunks = [
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-x",
          toolName: "x",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-y",
          toolName: "y",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];
    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    const interrupts = interruptsOf(events);
    // ids encode the snapshot runId (AG-UI run id here, chunks carry none).
    expect(interrupts.map((i) => i.id)).toEqual(["run-1::tc-x"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("tool call tc-y (y) after tc-x"),
    );
    warnSpy.mockRestore();
  });

  it("omits responseSchema when resumeSchema is not valid JSON", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-1",
            toolName: "t",
            suspendPayload: {},
            args: {},
            resumeSchema: "not-json",
          },
        },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    const [interrupt] = interruptsOf(events) as any[];
    expect(interrupt.responseSchema).toBeUndefined();
    // Raw value still available in metadata for debugging.
    expect(interrupt.metadata.mastra.resumeSchema).toBe("not-json");
  });

  it("a non-interrupting run still ends with a plain RUN_FINISHED (no outcome)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });
    const events = await collectEvents(agent, makeInput());

    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;
    expect(finished.outcome).toBeUndefined();
  });

  it("attaches outcome on the resume path when the resumed stream suspends again", async () => {
    const { agent } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-chained",
          toolName: "next-step",
          suspendPayload: { step: 2 },
          args: {},
          resumeSchema: "{}",
        },
      },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({ toolCallId: "tc-1", runId: "run-1" }),
    );

    const [interrupt] = interruptsOf(events) as any[];
    // Chained suspend in the resumed run; chunk carries no runId, so the id
    // encodes the resumed run's AG-UI runId.
    expect(interrupt.id).toBe("run-1::tc-chained");
    expect(interrupt.toolCallId).toBe("tc-chained");
    expect(interrupt.metadata.mastra.suspendPayload).toEqual({ step: 2 });
  });

  it("works for remote agents too", async () => {
    const agent = makeRemoteMastraAgent({ streamChunks: makeSuspendChunks() });
    const events = await collectEvents(agent, makeInput());

    expect(interruptsOf(events)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Resume input (RunAgentInput.resume)
// ---------------------------------------------------------------------------

describe("interrupt bridge: resume input", () => {
  describe("standard resume channel (RunAgentInput.resume)", () => {
    it("resumes from input.resume, decoding runId::toolCallId from interruptId", async () => {
      // The interruptId is the id we emitted (`${runId}::${toolCallId}`), so
      // the bridge decodes both.
      const { agent, calls } = makeFakeLocalAgentWithResumeStream([
        { type: "text-delta", payload: { text: "Approved." } },
      ]);

      const events = await collectEvents(
        agent,
        makeInput({
          resume: [
            {
              interruptId: "mastra-run-xyz::tc-1",
              status: "resolved",
              payload: { approved: true },
            },
          ],
        } as any),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].resumeData).toEqual({ approved: true });
      expect(calls[0].opts.toolCallId).toBe("tc-1");
      // runId decoded from the interruptId, not RunAgentInput.runId.
      expect(calls[0].opts.runId).toBe("mastra-run-xyz");
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("treats a cancelled ResumeEntry as a decline (no resumeStream call)", async () => {
      const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

      const events = await collectEvents(
        agent,
        makeInput({
          resume: [
            { interruptId: "r::tc-1", status: "cancelled", payload: null },
          ],
        } as any),
      );

      expect(calls).toHaveLength(0);
      const types = events.map((e) => e.type);
      expect(types).toContain(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_FINISHED);
    });

    it("round-trips over a remote agent's resumeStream", async () => {
      const { agent, calls } = makeFakeRemoteAgentWithResumeStream([
        { type: "text-delta", payload: { text: "Done." } },
      ]);

      const events = await collectEvents(
        agent,
        makeInput({
          resume: [
            {
              interruptId: "mastra-run-remote::tc-9",
              status: "resolved",
              payload: { chosen_time: "2pm" },
            },
          ],
        } as any),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].opts.toolCallId).toBe("tc-9");
      expect(calls[0].opts.runId).toBe("mastra-run-remote");
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK),
      ).toHaveLength(1);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("does not read a forwardedProps.command resume: the run starts fresh", async () => {
      const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream(
        [],
      );
      const streamSpy = vi.spyOn(fakeAgent, "stream");

      await collectEvents(
        agent,
        makeInput({
          forwardedProps: {
            command: {
              resume: { approved: true },
              interruptEvent: JSON.stringify({
                type: "mastra_suspend",
                toolCallId: "tc-1",
                runId: "run-1",
              }),
            },
          },
        }),
      );

      expect(calls).toHaveLength(0);
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });

    it("fails the run when the interrupt id names no tool call", async () => {
      const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

      const { error, events } = await collectRunError(
        agent,
        makeInput({
          resume: [{ interruptId: "run-1::", status: "resolved" }],
        } as any),
      );

      expect(error.name).toBe("ResumeRequestError");
      expect(error.message).toContain("names no tool call");
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
      ]);
      expect(calls).toHaveLength(0);
    });

    describe("branches on entry status, not payload value", () => {
      it("resumes a resolved entry that carries no payload", async () => {
        const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream([
          { type: "text-delta", payload: { text: "Resumed." } },
        ]);
        const streamSpy = vi.spyOn(fakeAgent, "stream");

        const events = await collectEvents(
          agent,
          makeInput({
            resume: [{ interruptId: "r::tc-1", status: "resolved" }],
          } as any),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].resumeData).toBeUndefined();
        expect(calls[0].opts).toMatchObject({ toolCallId: "tc-1", runId: "r" });
        expect(streamSpy).not.toHaveBeenCalled();
        expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
      });

      it("resumes a resolved entry whose payload is null", async () => {
        const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream([
          { type: "text-delta", payload: { text: "Resumed." } },
        ]);
        const streamSpy = vi.spyOn(fakeAgent, "stream");

        // The schema forbids a null payload, but a client that sends one must
        // still resume rather than start a fresh run.
        await collectEvents(
          agent,
          makeInput({
            resume: [
              { interruptId: "r::tc-1", status: "resolved", payload: null },
            ],
          } as any),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].resumeData).toBeNull();
        expect(calls[0].opts).toMatchObject({ toolCallId: "tc-1", runId: "r" });
        expect(streamSpy).not.toHaveBeenCalled();
      });

      it("resumes a resolved entry whose payload is false instead of declining", async () => {
        const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream([
          { type: "text-delta", payload: { text: "Resumed." } },
        ]);
        const streamSpy = vi.spyOn(fakeAgent, "stream");

        const events = await collectEvents(
          agent,
          makeInput({
            resume: [
              { interruptId: "r::tc-1", status: "resolved", payload: false },
            ],
          } as any),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].resumeData).toBe(false);
        expect(streamSpy).not.toHaveBeenCalled();
        expect(
          events.filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK),
        ).toHaveLength(1);
      });

      it("declines a cancelled entry even when its payload is truthy", async () => {
        const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream(
          [],
        );
        const streamSpy = vi.spyOn(fakeAgent, "stream");

        const events = await collectEvents(
          agent,
          makeInput({
            resume: [
              {
                interruptId: "r::tc-1",
                status: "cancelled",
                payload: { approved: true },
              },
            ],
          } as any),
        );

        expect(calls).toHaveLength(0);
        expect(streamSpy).not.toHaveBeenCalled();
        expect(events.map((e) => e.type)).toEqual([
          EventType.RUN_STARTED,
          EventType.RUN_FINISHED,
        ]);
      });

      it("resumes a resolved entry with no payload over a remote agent", async () => {
        const { agent, fakeAgent, calls } = makeFakeRemoteAgentWithResumeStream(
          [{ type: "text-delta", payload: { text: "Resumed." } }],
        );
        const streamSpy = vi.spyOn(fakeAgent, "stream");

        const events = await collectEvents(
          agent,
          makeInput({
            resume: [{ interruptId: "r::tc-1", status: "resolved" }],
          } as any),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].resumeData).toBeUndefined();
        expect(calls[0].opts).toMatchObject({ toolCallId: "tc-1", runId: "r" });
        expect(streamSpy).not.toHaveBeenCalled();
        expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
      });

      it("resumes a resolved entry whose payload is false over a remote agent", async () => {
        const { agent, fakeAgent, calls } = makeFakeRemoteAgentWithResumeStream(
          [{ type: "text-delta", payload: { text: "Resumed." } }],
        );
        const streamSpy = vi.spyOn(fakeAgent, "stream");

        await collectEvents(
          agent,
          makeInput({
            resume: [
              { interruptId: "r::tc-1", status: "resolved", payload: false },
            ],
          } as any),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].resumeData).toBe(false);
        expect(calls[0].opts).toMatchObject({ toolCallId: "tc-1", runId: "r" });
        expect(streamSpy).not.toHaveBeenCalled();
      });
    });

    it("fails the run instead of starting a fresh one when the resume entry is malformed", async () => {
      const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream(
        [],
      );
      const streamSpy = vi.spyOn(fakeAgent, "stream");

      const { error, events } = await collectRunError(
        agent,
        makeInput({
          resume: [{ interruptId: "", status: "resolved" }],
        } as any),
      );

      expect(error.name).toBe("ResumeRequestError");
      expect(error.message).toContain("Invalid resume entry");
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
      ]);
      expect(events[1]).toEqual({
        type: EventType.RUN_ERROR,
        message: error.message,
      });
      expect(calls).toHaveLength(0);
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it("fails the run without resuming when input.resume carries more than one entry", async () => {
      const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream(
        [],
      );
      // A run reports one interrupt, so only a defective client sends more.
      const ids = ["run-1::tc-x", "run-1::tc-y"];
      const streamSpy = vi.spyOn(fakeAgent, "stream");
      const { error, events } = await collectRunError(
        agent,
        makeInput({
          runId: "run-2",
          resume: ids.map((interruptId) => ({
            interruptId,
            status: "resolved",
            payload: { approved: true },
          })),
        } as any),
      );

      expect(calls).toHaveLength(0);
      expect(streamSpy).not.toHaveBeenCalled();
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
      ]);
      expect(error.name).toBe("ResumeRequestError");
      expect((error as any).code).toBe("MASTRA_MULTIPLE_RESUME_ENTRIES");
      for (const id of ids) expect(error.message).toContain(id);
      expect(events[1]).toEqual({
        type: EventType.RUN_ERROR,
        message: error.message,
        code: "MASTRA_MULTIPLE_RESUME_ENTRIES",
      });
    });

    it.each(["tool-call-suspended", "tool-call-approval"])(
      "leaves the thread resumable when a run suspends a second tool (%s)",
      async (secondPause) => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { agent, fakeAgent, calls } = makeFakeLocalAgentWithResumeStream([
          { type: "text-delta", payload: { text: "Done." } },
        ]);
        const pause = (type: string, toolCallId: string) => ({
          type,
          payload: {
            toolCallId,
            toolName: toolCallId,
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        });
        fakeAgent.streamChunks = [
          pause("tool-call-suspended", "tc-x"),
          pause(secondPause, "tc-y"),
        ];

        // The real client: the second run must address every interrupt the
        // first one reported, and the bridge must accept that resume.
        await agent.runAgent({ runId: "run-1" });
        const reported = agent.pendingInterrupts.map((i) => i.toolCallId);

        await agent.runAgent({
          runId: "run-2",
          resume: agent.pendingInterrupts.map((i) => ({
            interruptId: i.id,
            status: "resolved" as const,
            payload: { approved: true },
          })),
        });

        expect(reported).toEqual(["tc-x"]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tc-y"));
        expect(calls).toHaveLength(1);
        expect(calls[0].opts.toolCallId).toBe("tc-x");
        expect(agent.pendingInterrupts).toEqual([]);
        warnSpy.mockRestore();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Tool-call buffering
// ---------------------------------------------------------------------------

describe("interrupt bridge: tool-call buffering", () => {
  it("preserves normal tool-call → tool-result flow", async () => {
    const chunks = [
      {
        type: "tool-call",
        payload: {
          toolCallId: "tc-3",
          toolName: "get-weather",
          args: { city: "NYC" },
        },
      },
      {
        type: "tool-result",
        payload: { toolCallId: "tc-3", result: { temp: 72 } },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    const toolTypes = events
      .filter((e) =>
        [
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
        ].includes(e.type),
      )
      .map((e) => e.type);

    expect(toolTypes).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(interruptsOf(events)).toHaveLength(0);
  });

  it("flushes buffered tool-call at end of stream when nothing follows", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-4",
            toolName: "fire-and-forget",
            args: {},
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(1);
  });

  it("only suppresses the immediately preceding tool-call, not earlier ones", async () => {
    // tool-call A (normal) → tool-result A → tool-call B → tool-call-suspended B
    // A should be emitted, B should be suppressed
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-a", toolName: "tool-a", args: {} },
      },
      { type: "tool-result", payload: { toolCallId: "tc-a", result: "ok" } },
      {
        type: "tool-call",
        payload: { toolCallId: "tc-b", toolName: "tool-b", args: {} },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-b",
          toolName: "tool-b",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // tool-a's START/ARGS/END/RESULT should be emitted
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolCallId).toBe("tc-a");

    // tool-b should be suppressed — only the interrupt
    const interrupts = interruptsOf(events);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].toolCallId).toBe("tc-b");
  });

  it("remote error chunk stops processing: one RUN_ERROR, no post-error events", async () => {
    const chunks = [
      { type: "text-delta", payload: { text: "before" } },
      { type: "error", payload: { error: "something went wrong" } },
      { type: "text-delta", payload: { text: "after" } },
    ];

    const agent = makeRemoteMastraAgent({ streamChunks: chunks });
    const { error, events } = await collectRunError(agent, makeInput());

    expect(error.message).toBe("something went wrong");

    // Only RUN_STARTED + the pre-error text chunk + RUN_ERROR, no post-error text
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("before");
    const runErrors = events.filter((e) => e.type === EventType.RUN_ERROR);
    expect(runErrors).toHaveLength(1);
    expect((runErrors[0] as any).message).toBe("something went wrong");
    expect(events[events.length - 1].type).toBe(EventType.RUN_ERROR);
  });

  it("local error chunk does not trigger post-error onRunFinished work", async () => {
    const memory = new FakeMemory();
    let getWorkingMemoryCalled = false;
    // Track whether emitWorkingMemorySnapshot runs post-error
    memory.getWorkingMemory = async () => {
      getWorkingMemoryCalled = true;
      return JSON.stringify({ state: "data" });
    };

    const chunks = [
      { type: "text-delta", payload: { text: "before" } },
      { type: "error", payload: { error: "local agent failed" } },
    ];

    const agent = makeLocalMastraAgent({ memory, streamChunks: chunks });
    const { error, events } = await collectRunError(agent, makeInput());

    expect(error.message).toBe("local agent failed");
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.RUN_ERROR,
    ]);

    // Allow any pending async work (onRunFinished) to settle
    await new Promise((r) => setTimeout(r, 50));

    // emitWorkingMemorySnapshot should NOT run after an error chunk
    expect(getWorkingMemoryCalled).toBe(false);
  });

  it("remote error chunk does not trigger post-error onRunFinished work", async () => {
    // Remote agents don't have memory, so we verify no RUN_FINISHED is attempted
    // by checking the subscriber only received events before the error
    const chunks = [
      { type: "text-delta", payload: { text: "before" } },
      { type: "error", payload: { error: "remote agent failed" } },
      { type: "text-delta", payload: { text: "after" } },
    ];

    const agent = makeRemoteMastraAgent({ streamChunks: chunks });
    const { error, events } = await collectRunError(agent, makeInput());

    expect(error.message).toBe("remote agent failed");
    // RUN_STARTED + one text chunk, then the RUN_ERROR; no post-error events
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.RUN_ERROR,
    ]);
  });

  it("discards pending tool-call when tool-call-suspended has different toolCallId (no orphaned emit)", async () => {
    // tool-call(tc-A) → tool-call-suspended(tc-B): tc-A never executed,
    // so emitting TOOL_CALL_START/ARGS/END without a TOOL_CALL_RESULT is
    // a protocol violation. tc-A must be silently discarded.
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-A", toolName: "tool-a", args: { x: 1 } },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-B",
          toolName: "tool-b",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // tc-A must NOT be emitted — no TOOL_CALL events at all
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(0);

    // tc-B's suspend should still produce an interrupt
    const interrupts = interruptsOf(events);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].toolCallId).toBe("tc-B");
  });

  it("handles multiple tool-call-suspended events in one stream", async () => {
    // Two different tools both get suspended in the same stream
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-x", toolName: "tool-x", args: { a: 1 } },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-x",
          toolName: "tool-x",
          suspendPayload: { step: 1 },
          args: { a: 1 },
          resumeSchema: "{}",
        },
      },
      {
        type: "tool-call",
        payload: { toolCallId: "tc-y", toolName: "tool-y", args: { b: 2 } },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-y",
          toolName: "tool-y",
          suspendPayload: { step: 2 },
          args: { b: 2 },
          resumeSchema: "{}",
        },
      },
    ];

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // Both tool-calls should be suppressed
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(0);

    // Only the first suspension is reported; the run can resume one.
    const interrupts = interruptsOf(events);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].toolCallId).toBe("tc-x");
    warnSpy.mockRestore();
  });

  it("skips (does not abort on) a chunk with no payload (#1635)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta" }, // missing payload
        { type: "finish", payload: { finishReason: "stop" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping stream chunk without payload"),
    );
    warnSpy.mockRestore();
  });

  it("skips (does not abort on) a null chunk (#1635)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = makeLocalMastraAgent({
      streamChunks: [
        null,
        { type: "finish", payload: { finishReason: "stop" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping stream chunk without payload"),
    );
    warnSpy.mockRestore();
  });

  it("errors when tool-call-suspended payload is missing toolCallId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call-suspended",
          payload: {
            toolName: "some-tool",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });

    const { error, events } = await collectRunError(agent, makeInput());

    expect(error.message).toContain("Malformed tool-call-suspended");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("ignores unrecognized chunk types without crashing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "hello" } },
        { type: "unknown-future-type", payload: { data: 123 } },
        { type: "text-delta", payload: { text: " world" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    // Both text chunks should be emitted — the unknown chunk is skipped
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(2);

    // A warning should be logged for the unknown chunk type
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown-future-type"),
    );

    warnSpy.mockRestore();
  });

  it("buffers correctly for remote agents (processDataStream path)", async () => {
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-r", toolName: "remote-tool", args: {} },
      },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-r",
          toolName: "remote-tool",
          suspendPayload: {},
          args: {},
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeRemoteMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(0);
    expect(interruptsOf(events)).toHaveLength(1);
  });

  it("flushes buffered tool-call when text-delta arrives between tool-call and tool-call-suspended", async () => {
    // tool-call(tc-1) → text-delta → tool-call-suspended(tc-1)
    // The text-delta flushes the buffered tool-call, so tc-1 IS emitted.
    // The suspend still produces an interrupt (no matching pending to suppress).
    const chunks = [
      {
        type: "tool-call",
        payload: { toolCallId: "tc-1", toolName: "slow-tool", args: { x: 1 } },
      },
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-1",
          toolName: "slow-tool",
          suspendPayload: {},
          args: { x: 1 },
          resumeSchema: "{}",
        },
      },
    ];

    const agent = makeLocalMastraAgent({ streamChunks: chunks });
    const events = await collectEvents(agent, makeInput());

    // tc-1 was flushed by the text-delta, so TOOL_CALL_START is present
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolCallId).toBe("tc-1");

    // text-delta was emitted
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Processing...");

    // The suspend still produces an interrupt
    const interrupts = interruptsOf(events);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].toolCallId).toBe("tc-1");
  });
});

// ---------------------------------------------------------------------------
// Resume path
// ---------------------------------------------------------------------------

describe("interrupt bridge: resume path", () => {
  it("calls resumeStream with correct args for mastra_suspend on local agent", async () => {
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Expense approved." } },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "original-run-id",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].resumeData).toEqual({ approved: true });
    expect(calls[0].opts.toolCallId).toBe("tc-1");
    expect(calls[0].opts.runId).toBe("original-run-id");
    expect(calls[0].opts.memory).toEqual({
      thread: "thread-1",
      resource: "resource-1",
    });

    // Verify the resumed stream is actually processed
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Expense approved.");
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("emits TOOL_CALL_START/ARGS/END before RESULT on resume of a suspended tool", async () => {
    // First run discarded the triple on tool-call-suspended. Resume streams
    // only tool-result, so the adapter must introduce the id before RESULT
    // or CopilotKit drops the orphan tool message (#2668). The resume entry
    // carries no name or arguments; Mastra's tool-result does.
    const { agent } = makeFakeLocalAgentWithResumeStream([
      {
        type: "tool-result",
        payload: {
          toolCallId: "tc-1",
          toolName: "process-expense",
          args: { amount: 250, description: "team dinner" },
          result: { approved: true },
        },
      },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({ toolCallId: "tc-1", runId: "original-run-id" }),
    );

    const types = events.map((e) => e.type);
    const startAt = types.indexOf(EventType.TOOL_CALL_START);
    const argsAt = types.indexOf(EventType.TOOL_CALL_ARGS);
    const endAt = types.indexOf(EventType.TOOL_CALL_END);
    const resultAt = types.indexOf(EventType.TOOL_CALL_RESULT);
    expect(startAt).toBeGreaterThan(-1);
    expect(argsAt).toBeGreaterThan(startAt);
    expect(endAt).toBeGreaterThan(argsAt);
    expect(resultAt).toBeGreaterThan(endAt);

    const start = events[startAt] as import("@ag-ui/client").ToolCallStartEvent;
    expect(start.toolCallId).toBe("tc-1");
    expect(start.toolCallName).toBe("process-expense");
    const args = events[argsAt] as import("@ag-ui/client").ToolCallArgsEvent;
    expect(args.toolCallId).toBe("tc-1");
    expect(JSON.parse(args.delta)).toEqual({
      amount: 250,
      description: "team dinner",
    });
    const result = events[resultAt] as import("@ag-ui/client").ToolCallResultEvent;
    expect(result.toolCallId).toBe("tc-1");
  });

  it("uses tool-result args on standard resume when the interrupt has none", async () => {
    const resumeChunks = [
      {
        type: "tool-result",
        payload: {
          toolCallId: "tc-1",
          toolName: "process-expense",
          args: { amount: 250, description: "team dinner" },
          result: { approved: true },
        },
      },
    ];
    const { agent: localAgent } = makeFakeLocalAgentWithResumeStream(resumeChunks);
    const { agent: remoteAgent } =
      makeFakeRemoteAgentWithResumeStream(resumeChunks);

    const resumeInput = makeInput({
      resume: [
        {
          interruptId: "original-run-id::tc-1",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    } as any);

    for (const agent of [localAgent, remoteAgent]) {
      const events = await collectEvents(agent, resumeInput);
      const argsEvent = events.find((e) => e.type === EventType.TOOL_CALL_ARGS);
      expect(argsEvent).toBeDefined();
      expect(
        JSON.parse((argsEvent as import("@ag-ui/client").ToolCallArgsEvent).delta),
      ).toEqual({ amount: 250, description: "team dinner" });
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(1);
    }
  });

  it("does not replay START after text-delta already flushed the buffered call", async () => {
    const resumeChunks = [
      {
        type: "tool-call",
        payload: {
          toolCallId: "tc-1",
          toolName: "process-expense",
          args: { amount: 250 },
        },
      },
      { type: "text-delta", payload: { text: "working" } },
      {
        type: "tool-result",
        payload: {
          toolCallId: "tc-1",
          toolName: "process-expense",
          args: { amount: 250 },
          result: { approved: true },
        },
      },
    ];
    const { agent: localAgent } = makeFakeLocalAgentWithResumeStream(resumeChunks);
    const { agent: remoteAgent } =
      makeFakeRemoteAgentWithResumeStream(resumeChunks);

    const resumeInput = makeInput({
      resume: [
        {
          interruptId: "original-run-id::tc-1",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    } as any);

    for (const agent of [localAgent, remoteAgent]) {
      const events = await collectEvents(agent, resumeInput);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(1);
    }
  });

  it("treats a cancelled entry as a decline: RUN_FINISHED without calling resumeStream", async () => {
    // A cancelled entry means the user declined the tool call. The adapter
    // must NOT forward it to resumeStream; it closes the run cleanly.
    const { agent, calls } = makeFakeLocalAgentWithResumeStream([]);

    const events = await collectEvents(
      agent,
      makeDeclineInput({ toolCallId: "tc-1", runId: "run-1" }),
    );

    // resumeStream must NOT be called
    expect(calls).toHaveLength(0);

    // Run should complete cleanly
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("decline path emits STATE_SNAPSHOT before RUN_FINISHED when working memory is available", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.memory.workingMemoryValue = JSON.stringify({
      status: "pending_review",
    });

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeDeclineInput({ toolCallId: "tc-1", runId: "run-1" }),
    );

    const types = events.map((e) => e.type);

    // STATE_SNAPSHOT should come before RUN_FINISHED
    const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(snapshotIdx);

    const snapshot = events.find(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    ) as any;
    expect(snapshot.snapshot).toEqual({ status: "pending_review" });
  });

  it("handles chained interrupts in resumed stream", async () => {
    // The resumed stream itself emits another tool-call-suspended
    const { agent } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-chained",
          toolName: "next-step",
          suspendPayload: { step: 2 },
          args: {},
          resumeSchema: "{}",
        },
      },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const interrupts = interruptsOf(events) as any[];
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].toolCallId).toBe("tc-chained");
    expect(interrupts[0].metadata.mastra.suspendPayload).toEqual({ step: 2 });
  });

  it("propagates error when resumeStream throws", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => {
      throw new Error("Resume failed: no snapshot");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("Resume failed: no snapshot");
  });

  it("errors when resumeStream returns null", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => null;

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain(
      "resumeStream returned no valid response (missing fullStream)",
    );
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("emits STATE_SNAPSHOT before RUN_FINISHED when working memory is available", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.memory.workingMemoryValue = JSON.stringify({
      approved: true,
      notes: "lgtm",
    });

    const calls: Array<{ resumeData: any; opts: any }> = [];
    (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
      calls.push({ resumeData, opts });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: "Done." } };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const types = events.map((e) => e.type);
    // STATE_SNAPSHOT must come before RUN_FINISHED
    const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);

    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(finishedIdx).toBeGreaterThan(snapshotIdx);

    // Verify snapshot content
    const snapshot = events.find(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    ) as any;
    expect(snapshot.snapshot).toEqual({ approved: true, notes: "lgtm" });
  });

  it("still emits RUN_FINISHED when getWorkingMemory throws during resume, and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    // Make getWorkingMemory throw — simulates memory provider failure
    fakeAgent.memory.getWorkingMemory = async () => {
      throw new Error("Memory provider unavailable");
    };

    const calls: Array<{ resumeData: any; opts: any }> = [];
    (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
      calls.push({ resumeData, opts });
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: "Approved." } };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const types = events.map((e) => e.type);
    // Run should complete — memory failure is non-fatal
    expect(types).toContain(EventType.RUN_FINISHED);
    // But no STATE_SNAPSHOT since memory failed
    expect(types).not.toContain(EventType.STATE_SNAPSHOT);

    // A warning should be logged so operators can detect the issue
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to emit working memory snapshot"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("errors when resumeStream returns object without fullStream", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => ({ text: "done" }); // no fullStream

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain("fullStream");
  });

  it("propagates error chunk in resumed stream as one RUN_ERROR without RUN_FINISHED", async () => {
    const { agent } = makeFakeLocalAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Approving..." } },
      { type: "error", payload: { error: "LLM rate limited" } },
      { type: "text-delta", payload: { text: "should not appear" } },
    ]);

    const { error, events } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("LLM rate limited");
    // RUN_STARTED should be present, but no RUN_FINISHED or STATE_SNAPSHOT after error
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(
      events.filter((e) => e.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
    expect(
      events.filter((e) => e.type === EventType.STATE_SNAPSHOT),
    ).toHaveLength(0);
    // Only the pre-error text chunk
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Approving...");
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.RUN_ERROR,
    ]);
    expect((events[2] as any).message).toBe("LLM rate limited");
  });

  it("propagates memory management errors to subscriber", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.getMemory = async () => {
      throw new Error("Memory provider connection failed");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectRunError(
      agent,
      makeInput({ state: { someKey: "someValue" } }),
    );

    expect(error.message).toBe("Memory provider connection failed");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("propagates error when local agent .stream() throws (not silently dropped)", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    // Override stream to throw — simulates a network/auth failure
    fakeAgent.stream = async () => {
      throw new Error("Connection refused");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectRunError(agent, makeInput());

    // The error must reach the subscriber — not be silently swallowed
    expect(error.message).toBe("Connection refused");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("propagates error when remote agent .stream() throws (not silently dropped)", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    // Override stream to throw
    fakeAgent.stream = async () => {
      throw new Error("Remote auth failed");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectRunError(agent, makeInput());

    expect(error.message).toBe("Remote auth failed");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("errors when a remote agent has no resumeStream capability (old client-js)", async () => {
    // The Agent resource of @mastra/client-js 1.0.0 (the peer floor) has no
    // resumeStream, so the bridge must surface an actionable upgrade error,
    // not a generic crash. The bare agent has stream() (so it's remote, not
    // local, no getMemory) but no resume capability at all.
    const fakeAgent = {
      stream: async () => ({
        processDataStream: async () => {},
      }),
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain("upgrade @mastra/client-js");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("propagates errors thrown before any try-catch in run() to subscriber", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: [] });

    // Create input with a resume getter that throws: this hits the
    // input.resume access that decides which path the run takes.
    const input = makeInput();
    Object.defineProperty(input, "resume", {
      get() {
        throw new Error("Unexpected getter failure");
      },
    });

    const { error } = await collectRunError(agent, input);
    expect(error.message).toBe("Unexpected getter failure");
  });
});

// ---------------------------------------------------------------------------
// Resume path — remote agents (@mastra/client-js)
// ---------------------------------------------------------------------------

describe("interrupt bridge: remote resume path", () => {
  it("round-trips resume over resumeStream and processes the resumed stream", async () => {
    const { agent, calls } = makeFakeRemoteAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Expense approved." } },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        // Mastra keys the snapshot by the suspend chunk's runId — this must be
        // the value round-tripped to the remote resumeStream call.
        runId: "mastra-workflow-run-xyz",
      }),
    );

    // resumeStream called once with the round-tripped runId + toolCallId
    expect(calls).toHaveLength(1);
    expect(calls[0].resumeData).toEqual({ approved: true });
    expect(calls[0].opts.toolCallId).toBe("tc-1");
    expect(calls[0].opts.runId).toBe("mastra-workflow-run-xyz");
    expect(calls[0].opts.memory).toEqual({
      thread: "thread-1",
      resource: "resource-1",
    });

    // The resumed stream is processed and the run finishes
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Expense approved.");
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("produces an identical event sequence to a local resume", async () => {
    const resumeChunks = [{ type: "text-delta", payload: { text: "Done." } }];

    const localEvents = await collectEvents(
      makeFakeLocalAgentWithResumeStream(resumeChunks).agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );
    const remoteEvents = await collectEvents(
      makeFakeRemoteAgentWithResumeStream(resumeChunks).agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    // Local emits no STATE/MESSAGES snapshot here (no working memory set), so
    // the sequences match exactly: RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED.
    expect(remoteEvents.map((e) => e.type)).toEqual(
      localEvents.map((e) => e.type),
    );
    expect(remoteEvents.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.RUN_FINISHED,
    ]);
  });

  it("handles chained interrupts in the resumed remote stream", async () => {
    const { agent } = makeFakeRemoteAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Processing..." } },
      {
        type: "tool-call-suspended",
        payload: {
          toolCallId: "tc-chained",
          toolName: "next-step",
          suspendPayload: { step: 2 },
          args: {},
          resumeSchema: "{}",
        },
      },
    ]);

    const events = await collectEvents(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    const interrupts = interruptsOf(events) as any[];
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].toolCallId).toBe("tc-chained");
    expect(interrupts[0].metadata.mastra.suspendPayload).toEqual({ step: 2 });
  });

  it("propagates an error chunk in the resumed remote stream as one RUN_ERROR without RUN_FINISHED", async () => {
    const { agent } = makeFakeRemoteAgentWithResumeStream([
      { type: "text-delta", payload: { text: "Approving..." } },
      { type: "error", payload: { error: "LLM rate limited" } },
      { type: "text-delta", payload: { text: "should not appear" } },
    ]);

    const { error, events } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("LLM rate limited");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(
      events.filter((e) => e.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(1);
    expect((textChunks[0] as any).delta).toBe("Approving...");
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.RUN_ERROR,
    ]);
    expect((events[2] as any).message).toBe("LLM rate limited");
  });

  it("propagates an error when remote resumeStream throws", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => {
      throw new Error("No snapshot found for this workflow run");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toBe("No snapshot found for this workflow run");
  });

  it("errors when remote resumeStream returns no processDataStream", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    (fakeAgent as any).resumeStream = async () => ({ text: "done" });

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error, events } = await collectRunError(
      agent,
      makeResumeInput({
        toolCallId: "tc-1",
        runId: "run-1",
      }),
    );

    expect(error.message).toContain("processDataStream");
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  it("treats a cancelled entry as a decline for remote agents, with no resumeStream call", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });

    const events = await collectEvents(
      new MastraAgent({
        agentId: "test-agent",
        agent: fakeAgent as any,
        resourceId: "resource-1",
      }),
      makeDeclineInput({ toolCallId: "tc-1", runId: "run-1" }),
    );

    expect(fakeAgent.resumeCalls).toHaveLength(0);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });
});

// ---------------------------------------------------------------------------
// Native useInterrupt round-trip (behavioral contract)
// ---------------------------------------------------------------------------

// These tests lock the behavioral contract the CopilotKit v2 `useInterrupt`
// hook relies on, end-to-end against the real bridge. The hook reads the
// interrupts on RUN_FINISHED.outcome (`outcome: "interrupt"`), hands the first
// to `render` as `event.value`, and on resolve re-runs the agent with
// `RunAgentInput.resume = [{ interruptId, status, payload }]`. So the
// interrupt MUST (a) carry the suspend payload a renderer needs and (b) have an
// id that lets the bridge resume the suspended Mastra run.
describe("interrupt bridge: native useInterrupt round-trip", () => {
  it("the interrupt carries the render payload (suspendPayload + toolName) the hook exposes", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            args: { topic: "Intro with sales" },
          },
        },
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: { topic: "Intro with sales", attendee: "Alice" },
            args: { topic: "Intro with sales" },
            resumeSchema:
              '{"type":"object","properties":{"chosen_time":{"type":"string"}}}',
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput({ runId: "run-A" }));
    const [interrupt] = interruptsOf(events) as any[];

    expect(interrupt.metadata.mastra.toolName).toBe("schedule_meeting");
    expect(interrupt.metadata.mastra.suspendPayload).toEqual({
      topic: "Intro with sales",
      attendee: "Alice",
    });
  });

  it("resumes the suspended run when the hook answers the interrupt by id", async () => {
    // One agent plays both halves of the round-trip: the first run() suspends,
    // the second run() (the hook's resolve) resumes.
    const fakeAgent = new FakeLocalAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            args: { topic: "Intro with sales" },
          },
        },
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-sched",
            toolName: "schedule_meeting",
            suspendPayload: { topic: "Intro with sales", attendee: "Alice" },
            args: { topic: "Intro with sales" },
            resumeSchema: "{}",
          },
        },
      ],
    });
    const resumeCalls: Array<{ resumeData: any; opts: any }> = [];
    (fakeAgent as any).resumeStream = async (resumeData: any, opts: any) => {
      resumeCalls.push({ resumeData, opts });
      return {
        fullStream: (async function* () {
          yield {
            type: "text-delta",
            payload: { text: "Booked for 2pm Tuesday." },
          };
        })(),
      };
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    // 1) First run suspends with an interrupt outcome.
    const [interrupt] = interruptsOf(
      await collectEvents(agent, makeInput({ runId: "run-A" })),
    );

    // 2) The hook resolves with the user's picked slot.
    const resumeEvents = await collectEvents(
      agent,
      makeInput({
        runId: "run-B",
        resume: [
          {
            interruptId: interrupt.id,
            status: "resolved",
            payload: {
              chosen_time: "2026-07-01T14:00",
              chosen_label: "2pm Tue",
            },
          },
        ],
      } as any),
    );

    // The bridge decoded toolCallId + runId from the id and resumed the
    // original suspended run, not a fresh one.
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].opts.toolCallId).toBe("tc-sched");
    expect(resumeCalls[0].opts.runId).toBe("run-A");
    expect(resumeCalls[0].resumeData).toEqual({
      chosen_time: "2026-07-01T14:00",
      chosen_label: "2pm Tue",
    });

    // The resumed stream produced the assistant's confirmation and finished.
    const text = resumeEvents.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;
    expect(text.delta).toBe("Booked for 2pm Tuesday.");
    expect(resumeEvents[resumeEvents.length - 1].type).toBe(
      EventType.RUN_FINISHED,
    );
  });
});
