import { describe, it, expect } from "vitest";
import { EventType, PROTOCOL_VERSION } from "@ag-ui/client";
import type {
  BaseEvent,
  RunFinishedEvent,
  Tool,
  ToolCallResultEvent,
} from "@ag-ui/client";
import {
  RunFinishedEventSchema,
  RunStartedEventSchema,
} from "@ag-ui/core/schemas";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";
import { MastraAgent } from "../mastra";

// How a run reports itself at its two ends: the protocol version it speaks on
// RUN_STARTED, and on RUN_FINISHED the frontend tool calls it stopped on.

const SHOW_CHART: Tool = {
  name: "show_chart",
  description: "Render a chart",
  parameters: { type: "object", properties: {} },
};
const PICK_DATE: Tool = {
  name: "pick_date",
  description: "Ask the user for a date",
  parameters: { type: "object", properties: {} },
};

function frontendCall(toolCallId: string, toolName: string) {
  return [
    {
      type: "tool-call-input-streaming-start",
      payload: { toolCallId, toolName },
    },
    { type: "tool-call-delta", payload: { toolCallId, argsTextDelta: "{}" } },
    { type: "tool-call-input-streaming-end", payload: { toolCallId } },
    { type: "tool-call", payload: { toolCallId, toolName, args: {} } },
  ];
}

function serverCallWithResult(toolCallId: string) {
  return [
    {
      type: "tool-call",
      payload: { toolCallId, toolName: "lookup", args: { q: "x" } },
    },
    {
      type: "tool-result",
      payload: { toolCallId, toolName: "lookup", result: { found: true } },
    },
  ];
}

const finish = { type: "finish", payload: {} };

function finished(events: BaseEvent[]): RunFinishedEvent {
  const last = events[events.length - 1] as RunFinishedEvent;
  expect(last.type).toBe(EventType.RUN_FINISHED);
  return last;
}

describe("RUN_STARTED declares the protocol version", () => {
  it("on a run", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });
    const [started] = await collectEvents(agent, makeInput());

    expect(started).toMatchObject({
      type: EventType.RUN_STARTED,
      threadId: "thread-1",
      runId: "run-1",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(PROTOCOL_VERSION).toBe("1.0");
    expect(() => RunStartedEventSchema.parse(started)).not.toThrow();
  });

  it("on a resumed run and on a declined one", async () => {
    const agent = makeRemoteMastraAgent({ resumeChunks: [finish] });
    for (const status of ["resolved", "cancelled"] as const) {
      const [started] = await collectEvents(
        agent,
        makeInput({ resume: [{ interruptId: "r::tc-1", status }] }),
      );
      expect((started as any).protocolVersion).toBe(PROTOCOL_VERSION);
    }
  });
});

describe("RUN_FINISHED names the frontend tool calls a run stopped on", () => {
  it.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ] as const)(
    "finishes a %s run as success with pendingToolCallIds",
    async (_kind, makeAgent) => {
      const agent = makeAgent({
        streamChunks: [...frontendCall("tc-chart", "show_chart"), finish],
      });
      const events = await collectEvents(
        agent,
        makeInput({ tools: [SHOW_CHART] }),
      );

      const event = finished(events);
      expect(event.outcome).toEqual({
        type: "success",
        pendingToolCallIds: ["tc-chart"],
      });
      expect(() => RunFinishedEventSchema.parse(event)).not.toThrow();
      expect(events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(
        false,
      );
    },
  );

  it("lists several unanswered calls in the order they were made", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        ...frontendCall("tc-2", "pick_date"),
        ...frontendCall("tc-1", "show_chart"),
        finish,
      ],
    });
    const events = await collectEvents(
      agent,
      makeInput({ tools: [SHOW_CHART, PICK_DATE] }),
    );

    expect(finished(events).outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["tc-2", "tc-1"],
    });
  });

  it("leaves out calls the run answered itself", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        ...serverCallWithResult("tc-server"),
        ...frontendCall("tc-chart", "show_chart"),
        finish,
      ],
    });
    const events = await collectEvents(
      agent,
      makeInput({ tools: [SHOW_CHART] }),
    );

    expect(finished(events).outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["tc-chart"],
    });
  });

  it("names nothing when the run answered every call", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [...serverCallWithResult("tc-server"), finish],
    });
    const events = await collectEvents(
      agent,
      makeInput({ tools: [SHOW_CHART] }),
    );

    expect(finished(events).outcome).toBeUndefined();
  });

  it("answers a server call left without a result, so only frontend calls stay pending", async () => {
    // A server call is not the application's to answer. Left unanswered, a
    // consumer would derive it as pending from the stream, so the bridge
    // answers it before the run ends.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: { toolCallId: "tc-server", toolName: "lookup", args: {} },
        },
        ...frontendCall("tc-chart", "show_chart"),
        finish,
      ],
    });
    const events = await collectEvents(
      agent,
      makeInput({ tools: [SHOW_CHART] }),
    );

    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_START),
    ).toHaveLength(2);
    const results = events.filter(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as ToolCallResultEvent[];
    expect(results.map((e) => e.toolCallId)).toEqual(["tc-server"]);
    expect(finished(events).outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["tc-chart"],
    });
  });

  it("hands the client only the frontend calls when a server call went unanswered", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: { toolCallId: "tc-server", toolName: "lookup", args: {} },
        },
        ...frontendCall("tc-chart", "show_chart"),
        finish,
      ],
    });
    let seen: unknown;
    await agent.runAgent(
      { tools: [SHOW_CHART] },
      {
        onRunFinishedEvent: (params) => {
          seen = params.outcome === "success" && params.pendingToolCallIds;
        },
      },
    );

    expect(seen).toEqual(["tc-chart"]);
  });

  it("leaves the client nothing pending when the only unanswered call is the server's", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: { toolCallId: "tc-server", toolName: "lookup", args: {} },
        },
        finish,
      ],
    });
    let seen: unknown;
    await agent.runAgent(
      { tools: [SHOW_CHART] },
      {
        onRunFinishedEvent: (params) => {
          seen = params.outcome === "success" && params.pendingToolCallIds;
        },
      },
    );

    expect(seen).toEqual([]);
  });

  describe("the A2UI render subagent's streamed call is the bridge's own", () => {
    const RENDER_A2UI: Tool = {
      name: "render_a2ui",
      description: "Render A2UI",
      parameters: { type: "object", properties: {} },
    };
    const renderId = "a2ui-render-1-render_a2ui";
    const streamedRender = [
      {
        type: "data-a2ui-render",
        payload: {
          phase: "start",
          toolCallId: renderId,
          toolName: "render_a2ui",
        },
      },
      {
        type: "data-a2ui-render",
        payload: { phase: "delta", toolCallId: renderId, argsTextDelta: "{}" },
      },
      {
        type: "data-a2ui-render",
        payload: { phase: "end", toolCallId: renderId },
      },
    ];

    type Fake = FakeLocalAgent | FakeRemoteAgent;

    // A local agent whose A2UI planning runs for real against `existingTools`.
    const local =
      (existingTools: Record<string, unknown>) => (streamChunks: any[]) =>
        Object.assign(
          new FakeLocalAgent({
            streamChunks,
            model: { provider: "test", modelId: "test-model" },
          }),
          { listTools: async () => existingTools },
        );
    const remote = (streamChunks: any[]) =>
      new FakeRemoteAgent({ streamChunks });

    // [label, agent, whether planning leaves `render_a2ui` offered to Mastra]
    const cases: Array<[string, (streamChunks: any[]) => Fake, boolean]> = [
      // Auto-injected: planning drops `render_a2ui` for `generate_a2ui`.
      ["auto-injected", local({}), false],
      // The developer wired `generate_a2ui`, so planning injects nothing.
      [
        "developer-wired",
        local({ generate_a2ui: { id: "generate_a2ui" } }),
        true,
      ],
      // A remote agent plans nothing.
      ["remote", remote, true],
    ];

    async function run(fake: Fake, tools: Tool[]) {
      const agent = new MastraAgent({
        agentId: "test-agent",
        agent: fake as any,
        resourceId: "resource-1",
      });
      const events = await collectEvents(
        agent,
        makeInput({ tools, forwardedProps: { injectA2UITool: true } }),
      );
      return { events, offered: Object.keys(fake.lastStreamOpts.clientTools) };
    }

    it.each(cases)(
      "is not pending and is answered (%s)",
      async (_label, make, renderOffered) => {
        const { events, offered } = await run(
          make([...streamedRender, finish]),
          [RENDER_A2UI],
        );

        expect(offered.includes("render_a2ui")).toBe(renderOffered);
        expect(
          events.filter(
            (e) =>
              e.type === EventType.TOOL_CALL_RESULT &&
              (e as any).toolCallId === renderId,
          ),
        ).toHaveLength(1);
        expect(finished(events).outcome).toBeUndefined();
      },
    );

    it.each(cases)(
      "leaves only the frontend call pending (%s)",
      async (_label, make, renderOffered) => {
        const { events, offered } = await run(
          make([
            ...streamedRender,
            ...frontendCall("tc-chart", "show_chart"),
            finish,
          ]),
          [RENDER_A2UI, SHOW_CHART],
        );

        expect(offered.includes("render_a2ui")).toBe(renderOffered);
        expect(finished(events).outcome).toEqual({
          type: "success",
          pendingToolCallIds: ["tc-chart"],
        });
      },
    );
  });

  it("an interrupted run reports the interrupt, not pending calls", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        ...frontendCall("tc-chart", "show_chart"),
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "tc-approve",
            toolName: "approve",
            suspendPayload: {},
            args: {},
            resumeSchema: "{}",
          },
        },
      ],
    });
    const events = await collectEvents(
      agent,
      makeInput({ tools: [SHOW_CHART] }),
    );

    expect(finished(events).outcome?.type).toBe("interrupt");
  });

  it("names the call a resumed run stops on", async () => {
    const fake = new FakeLocalAgent({
      resumeChunks: [
        {
          type: "tool-result",
          payload: {
            toolCallId: "tc-approve",
            toolName: "approve",
            args: {},
            result: { ok: true },
          },
        },
        {
          type: "tool-call",
          payload: { toolCallId: "tc-chart", toolName: "show_chart", args: {} },
        },
        finish,
      ],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });
    const events = await collectEvents(
      agent,
      makeInput({
        tools: [SHOW_CHART],
        resume: [{ interruptId: "mastra-run::tc-approve", status: "resolved" }],
      }),
    );

    expect(finished(events).outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["tc-chart"],
    });
  });

  it("reaches the client subscriber as the run's pending calls", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [...frontendCall("tc-chart", "show_chart"), finish],
    });
    let seen: unknown;
    await agent.runAgent(
      { tools: [SHOW_CHART] },
      {
        onRunFinishedEvent: (params) => {
          seen = params.outcome === "success" && params.pendingToolCallIds;
        },
      },
    );

    expect(seen).toEqual(["tc-chart"]);
  });
});

// A cancelled run waits for nothing and has no return value
// (docs/spec/1.0/events/lifecycle.mdx, "Cancelled runs"), so cancellation
// outranks every other ending: no interrupts, no pendingToolCallIds, no result.

const mastraAbort = { type: "abort", runId: "r1", from: "AGENT", payload: {} };

function suspended(toolCallId: string) {
  return {
    type: "tool-call-suspended",
    payload: {
      toolCallId,
      toolName: "approve",
      suspendPayload: {},
      args: {},
      resumeSchema: "{}",
    },
  };
}

describe("RUN_FINISHED reports a cancelled run as cancelled, over anything else", () => {
  it.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ] as const)(
    "a %s run stopped after a frontend call names no pending calls",
    async (_kind, makeAgent) => {
      const agent = makeAgent({
        streamChunks: [...frontendCall("tc-chart", "show_chart"), mastraAbort],
      });
      const events = await collectEvents(
        agent,
        makeInput({ tools: [SHOW_CHART] }),
      );

      // The call was delivered, so without the stop it would be pending.
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(1);
      const event = finished(events);
      expect(event.outcome).toEqual({ type: "cancelled" });
      expect(() => RunFinishedEventSchema.parse(event)).not.toThrow();
    },
  );

  it.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ] as const)(
    "a %s run stopped after a suspend carries no interrupts",
    async (_kind, makeAgent) => {
      const agent = makeAgent({
        streamChunks: [suspended("tc-approve"), mastraAbort],
      });
      const events = await collectEvents(agent, makeInput());

      const event = finished(events);
      expect(event.outcome).toEqual({ type: "cancelled" });
      expect(() => RunFinishedEventSchema.parse(event)).not.toThrow();
    },
  );

  it.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ] as const)(
    "a %s run stopped with a traceId reports no result",
    async (_kind, makeAgent) => {
      const text = { type: "text-delta", payload: { text: "partial" } };

      // The same run left to complete surfaces the traceId, so the stop is
      // what withholds it.
      const completed = await collectEvents(
        makeAgent({ streamChunks: [text, finish], traceId: "trace-1" }),
        makeInput(),
      );
      expect(finished(completed).result).toEqual({ traceId: "trace-1" });

      const stopped = await collectEvents(
        makeAgent({ streamChunks: [text, mastraAbort], traceId: "trace-1" }),
        makeInput(),
      );
      const event = finished(stopped);
      expect(event.outcome).toEqual({ type: "cancelled" });
      expect("result" in event).toBe(false);
    },
  );

  it("a run stopped after a frontend call, a suspend and a traceId reports only the stop", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        ...frontendCall("tc-chart", "show_chart"),
        suspended("tc-approve"),
        mastraAbort,
      ],
      traceId: "trace-1",
    });
    const events = await collectEvents(
      agent,
      makeInput({ tools: [SHOW_CHART] }),
    );

    const event = finished(events);
    expect(event.outcome).toEqual({ type: "cancelled" });
    expect("result" in event).toBe(false);
  });

  it("abortRun() after a suspend ends the run cancelled, without its interrupt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = new FakeLocalAgent();
    fake.stream = async () => ({
      fullStream: (async function* () {
        yield suspended("tc-approve");
        yield { type: "text-delta", payload: { text: "waiting" } };
        await gate;
      })(),
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      agent.run(makeInput()).subscribe({
        next: (event) => {
          events.push(event);
          // Past the suspend: the interrupt is collected, the run still open.
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) agent.abortRun();
        },
        error: reject,
        complete: resolve,
      });
    });
    release();

    const event = finished(events);
    expect(event.outcome).toEqual({ type: "cancelled" });
    expect(() => RunFinishedEventSchema.parse(event)).not.toThrow();
  });
});
