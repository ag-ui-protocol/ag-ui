import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  getLocalAgent,
  getLocalAgents,
  getNetwork,
  getRemoteAgents,
} from "../utils";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  collectEvents,
  runThroughClient,
} from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  attributed,
  capture,
  indexOf,
  localAgent,
  ofType,
  stableOutline,
  verified,
} from "./subagent-helpers";

// One delegation (`agent-researcher`, call `deleg-1`) on a real Mastra 1.74
// supervisor stream: the sub-agent reasons, says "Let me look.", calls
// `lookup` (which also writes progress output), then answers "Answer from a.".

const SUPERVISOR_MESSAGE = "2a1c5d51-ccf7-438e-ae56-d9f36f272062";
const LANE_MESSAGE = "deleg-1/9ab7fca4-c989-48ee-94a8-e66a2ca20740";

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(PATHS)("an attributed delegation (%s)", (_path, make) => {
  it("streams as one invocation between the delegating call and its result", async () => {
    const chunks = capture("a-single");
    const events = await collectEvents(
      make(chunks, attributed).agent,
      FIRST_TURN,
    );

    expect(stableOutline(events, chunks)).toEqual([
      "RUN_STARTED",
      `TEXT_MESSAGE_CHUNK ${SUPERVISOR_MESSAGE}`,
      "TOOL_CALL_START deleg-1",
      "TOOL_CALL_ARGS deleg-1",
      "TOOL_CALL_END deleg-1",
      "SUBAGENT_STARTED deleg-1 researcher",
      "REASONING_START deleg-1/<id> [deleg-1]",
      "REASONING_MESSAGE_START deleg-1/<id> [deleg-1]",
      "REASONING_MESSAGE_CONTENT deleg-1/<id> [deleg-1]",
      "REASONING_MESSAGE_END deleg-1/<id> [deleg-1]",
      "REASONING_END deleg-1/<id> [deleg-1]",
      `TEXT_MESSAGE_CHUNK ${LANE_MESSAGE} [deleg-1]`,
      `TEXT_MESSAGE_CHUNK ${LANE_MESSAGE} [deleg-1]`,
      "TOOL_CALL_START deleg-1/sub-call-a-0 [deleg-1]",
      "TOOL_CALL_ARGS deleg-1/sub-call-a-0 [deleg-1]",
      "TOOL_CALL_ARGS deleg-1/sub-call-a-0 [deleg-1]",
      "TOOL_CALL_END deleg-1/sub-call-a-0 [deleg-1]",
      "TOOL_CALL_RESULT deleg-1/sub-call-a-0 [deleg-1]",
      // Text after the sub-agent's tool call is its own message, as for the
      // supervisor (continuation split).
      `TEXT_MESSAGE_CHUNK ${LANE_MESSAGE}-agui-text [deleg-1]`,
      "SUBAGENT_FINISHED deleg-1",
      "TOOL_CALL_RESULT deleg-1",
      `TEXT_MESSAGE_CHUNK ${SUPERVISOR_MESSAGE}-agui-text`,
      "RUN_FINISHED",
    ]);
    await verified(events);
  });

  it("announces the invocation with its name, call and the message holding it", async () => {
    const events = await collectEvents(
      make(capture("a-single"), attributed).agent,
      FIRST_TURN,
    );
    expect(ofType(events, EventType.SUBAGENT_STARTED)).toEqual([
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "deleg-1",
        name: "researcher",
        parentToolCallId: "deleg-1",
        parentMessageId: SUPERVISOR_MESSAGE,
      },
    ]);
    expect(ofType(events, EventType.SUBAGENT_FINISHED)).toEqual([
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "deleg-1" },
    ]);
  });

  it("streams the sub-agent's calls live under its own message, with their results", async () => {
    const events = await collectEvents(
      make(capture("a-single"), attributed).agent,
      FIRST_TURN,
    );
    const [start] = ofType(events, EventType.TOOL_CALL_START).filter(
      (event) => event.subagentRunId,
    );
    expect(start).toMatchObject({
      toolCallId: "deleg-1/sub-call-a-0",
      toolCallName: "lookup",
      parentMessageId: LANE_MESSAGE,
      subagentRunId: "deleg-1",
    });
    expect(
      ofType(events, EventType.TOOL_CALL_ARGS)
        .filter((event) => event.toolCallId === "deleg-1/sub-call-a-0")
        .map((event) => event.delta)
        .join(""),
    ).toBe('{"q":"a"}');
    const results = ofType(events, EventType.TOOL_CALL_RESULT);
    expect(results[0]).toMatchObject({
      toolCallId: "deleg-1/sub-call-a-0",
      content: JSON.stringify({ answer: "facts about a" }),
      subagentRunId: "deleg-1",
    });
    // The supervisor owns its delegating call's result.
    expect(results[1].toolCallId).toBe("deleg-1");
    expect(results[1]).not.toHaveProperty("subagentRunId");
    expect(JSON.parse(results[1].content).text).toBe("Answer from a.");
  });

  it("drops a sub-agent tool's writer output, as for the supervisor's own tools", async () => {
    const events = await collectEvents(
      make(capture("a-single"), attributed).agent,
      FIRST_TURN,
    );
    expect(JSON.stringify(events)).not.toContain("progress");
  });

  it("announces a call held back (streamServerToolCalls off) before its invocation", async () => {
    const events = await collectEvents(
      make(capture("a-single"), attributed).agent,
      FIRST_TURN,
    );
    expect(
      indexOf(
        events,
        (e) => e.type === EventType.TOOL_CALL_END && e.toolCallId === "deleg-1",
      ),
    ).toBeLessThan(
      indexOf(events, (e) => e.type === EventType.SUBAGENT_STARTED),
    );
  });

  it("closes a live-streamed delegating call before its invocation (streamServerToolCalls on)", async () => {
    const events = await collectEvents(
      make(capture("a-single"), {
        ...attributed,
        streamServerToolCalls: true,
      }).agent,
      FIRST_TURN,
    );
    const args = ofType(events, EventType.TOOL_CALL_ARGS).filter(
      (event) => event.toolCallId === "deleg-1",
    );
    expect(args.map((event) => event.delta)).toEqual([
      '{"prompt":"',
      'research a"}',
    ]);
    expect(
      indexOf(
        events,
        (e) => e.type === EventType.TOOL_CALL_END && e.toolCallId === "deleg-1",
      ),
    ).toBeLessThan(
      indexOf(events, (e) => e.type === EventType.SUBAGENT_STARTED),
    );
    await verified(events);
  });

  it("keeps the delegation's own result when the sub-agent's results are omitted", async () => {
    const events = await collectEvents(
      make(capture("a-single"), {
        ...attributed,
        subagentToolResults: "omit",
      }).agent,
      FIRST_TURN,
    );
    const [inner, delegation] = ofType(events, EventType.TOOL_CALL_RESULT);
    expect(inner).toMatchObject({
      toolCallId: "deleg-1/sub-call-a-0",
      content: "",
      subagentRunId: "deleg-1",
    });
    expect(JSON.parse(delegation.content).text).toBe("Answer from a.");
    await verified(events);
  });

  it("keeps a failed call's error when the sub-agent's results are omitted", async () => {
    const events = await collectEvents(
      make(capture("d-subtool-throws"), {
        ...attributed,
        subagentToolResults: "omit",
      }).agent,
      FIRST_TURN,
    );
    const [inner] = ofType(events, EventType.TOOL_CALL_RESULT);
    expect(inner).toMatchObject({
      toolCallId: "deleg-d/sub-call-d-0",
      content: JSON.stringify({ error: "lookup exploded" }),
      subagentRunId: "deleg-d",
    });
  });

  it("lands in the client as the sub-agent's messages, apart from the supervisor's", async () => {
    const messages = await runThroughClient(
      make(capture("a-single"), attributed).agent,
      FIRST_TURN.messages,
      {},
    );
    const summary = messages.map((message: any) => ({
      // Reasoning and tool message ids are minted at random.
      id:
        message.role === "reasoning" || message.role === "tool"
          ? "<id>"
          : message.id,
      role: message.role,
      ...(message.subagentRunId
        ? { subagentRunId: message.subagentRunId }
        : {}),
      ...(message.content ? { content: message.content } : {}),
      ...(message.toolCalls
        ? { toolCalls: message.toolCalls.map((call: any) => call.id) }
        : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    }));
    expect(summary.map(({ content, ...rest }: any) => rest)).toEqual([
      { id: "user-1", role: "user" },
      { id: SUPERVISOR_MESSAGE, role: "assistant", toolCalls: ["deleg-1"] },
      // The client places a result right after the message holding its call.
      { id: "<id>", role: "tool", toolCallId: "deleg-1" },
      { id: "<id>", role: "reasoning", subagentRunId: "deleg-1" },
      {
        id: LANE_MESSAGE,
        role: "assistant",
        subagentRunId: "deleg-1",
        toolCalls: ["deleg-1/sub-call-a-0"],
      },
      {
        id: "<id>",
        role: "tool",
        subagentRunId: "deleg-1",
        toolCallId: "deleg-1/sub-call-a-0",
      },
      {
        id: `${LANE_MESSAGE}-agui-text`,
        role: "assistant",
        subagentRunId: "deleg-1",
      },
      { id: `${SUPERVISOR_MESSAGE}-agui-text`, role: "assistant" },
    ]);
    expect(summary.find((m: any) => m.id === LANE_MESSAGE)?.content).toBe(
      "Let me look.",
    );
    expect(
      summary.find((m: any) => m.id === `${LANE_MESSAGE}-agui-text`)?.content,
    ).toBe("Answer from a.");
    expect(
      summary.find((m: any) => m.role === "tool" && m.toolCallId === "deleg-1"),
    ).not.toHaveProperty("subagentRunId");
  });

  it("never sends a sub-agent's provider reasoning artefacts or working memory", async () => {
    // Scripted on the captured shapes: a signed reasoning span and a working
    // memory update inside the sub-agent.
    const wrap = (type: string, payload: unknown) => ({
      type: "tool-output",
      from: "USER",
      payload: {
        toolCallId: "deleg-1",
        toolName: "agent-researcher",
        output: { type, from: "AGENT", payload },
      },
    });
    const chunks = [
      { type: "start", from: "AGENT", payload: { messageId: "sup" } },
      {
        type: "tool-call",
        from: "AGENT",
        payload: {
          toolCallId: "deleg-1",
          toolName: "agent-researcher",
          args: {},
        },
      },
      wrap("start", { messageId: "sub" }),
      wrap("reasoning-start", { id: "r1" }),
      wrap("reasoning-delta", { id: "r1", text: "thinking" }),
      wrap("reasoning-end", { id: "r1", signature: "sig-1" }),
      wrap("tool-call", {
        toolCallId: "wm-1",
        toolName: "updateWorkingMemory",
        args: { memory: '{"draft":true}' },
      }),
      wrap("tool-result", {
        toolCallId: "wm-1",
        toolName: "updateWorkingMemory",
        result: { success: true },
      }),
      wrap("finish", { messageId: "sub" }),
      {
        type: "tool-result",
        from: "AGENT",
        payload: {
          toolCallId: "deleg-1",
          toolName: "agent-researcher",
          result: { text: "" },
        },
      },
      { type: "finish", from: "AGENT", payload: { messageId: "sup" } },
    ];
    const events = await collectEvents(
      make(chunks, attributed).agent,
      FIRST_TURN,
    );
    const types = events.map((event) => event.type);
    expect(types).not.toContain(EventType.REASONING_ENCRYPTED_VALUE);
    expect(types).not.toContain(EventType.STATE_SNAPSHOT);
    expect(types).not.toContain(EventType.STATE_DELTA);
    expect(JSON.stringify(events)).not.toContain("wm-1");
    expect(ofType(events, EventType.REASONING_MESSAGE_CONTENT)).toEqual([
      expect.objectContaining({ delta: "thinking", subagentRunId: "deleg-1" }),
    ]);
    await verified(events);
  });
});

describe("an attributed delegation of a local supervisor", () => {
  it("describes the sub-agent from the supervisor's own agents", async () => {
    const { agent } = localAgent(capture("a-single"), attributed, {
      listAgents: async () => ({
        researcher: { getDescription: () => "Finds facts." },
      }),
    });
    const events = await collectEvents(agent, FIRST_TURN);
    expect(ofType(events, EventType.SUBAGENT_STARTED)[0].description).toBe(
      "Finds facts.",
    );
  });

  it("streams without a description when the sub-agents cannot be listed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent } = localAgent(capture("a-single"), attributed, {
      listAgents: async () => {
        throw new Error("agents unavailable");
      },
    });
    const events = await collectEvents(agent, FIRST_TURN);
    expect(ofType(events, EventType.SUBAGENT_STARTED)[0]).not.toHaveProperty(
      "description",
    );
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to list the sub-agents"),
      expect.any(Error),
    );
  });

  it("declares its sub-agents as capabilities only when they are attributed", async () => {
    // The fake memory has no thread config, which capabilities report on.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listAgents = async () => ({
      researcher: { getDescription: () => "Finds facts." },
      writer: { getDescription: () => "" },
    });
    const attributedAgent = localAgent([], attributed, { listAgents }).agent;
    expect((await attributedAgent.getCapabilities()).multiAgent).toEqual({
      supported: true,
      delegation: true,
      subagents: [
        { name: "researcher", description: "Finds facts." },
        { name: "writer" },
      ],
    });
    const hiddenAgent = localAgent([], {}, { listAgents }).agent;
    expect(await hiddenAgent.getCapabilities()).not.toHaveProperty(
      "multiAgent",
    );
    const soloAgent = localAgent([], attributed, {
      listAgents: async () => ({}),
    }).agent;
    expect(await soloAgent.getCapabilities()).not.toHaveProperty("multiAgent");
  });
});

describe("the sub-agent options", () => {
  it("are carried by every agent factory and by clone()", async () => {
    const options = {
      subagentVisibility: "attributed",
      subagentToolResults: "omit",
    } as const;
    const local = new FakeLocalAgent();
    const mastra = {
      listAgents: () => ({ supervisor: local }),
      getAgent: () => local,
    } as any;
    const client = {
      listAgents: async () => ({ supervisor: {} }),
      getAgent: () => new FakeRemoteAgent(),
    } as any;
    const agents = [
      getLocalAgents({ mastra, resourceId: "r", ...options }).supervisor,
      getLocalAgent({
        mastra,
        agentId: "supervisor",
        resourceId: "r",
        ...options,
      }),
      getNetwork({
        mastra,
        networkId: "supervisor",
        resourceId: "r",
        ...options,
      }),
      (
        await getRemoteAgents({
          mastraClient: client,
          resourceId: "r",
          ...options,
        })
      ).supervisor,
    ] as MastraAgent[];
    for (const agent of [...agents, agents[0].clone()]) {
      expect(agent.subagentVisibility).toBe("attributed");
      expect(agent.subagentToolResults).toBe("omit");
    }
    const defaults = getLocalAgents({ mastra, resourceId: "r" })
      .supervisor as MastraAgent;
    expect(defaults.subagentVisibility).toBe("hidden");
    expect(defaults.subagentToolResults).toBe("full");
  });
});

describe.each(PATHS)(
  "tool output that is not a delegation (%s)",
  (_path, make) => {
    it("is not attributed, and an unknown shape warns once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const forwarded = (toolName: string, from: string, text: string) => ({
        type: "tool-output",
        from: "USER",
        payload: {
          toolCallId: "call-1",
          toolName,
          output: { type: "text-delta", from, payload: { text } },
        },
      });
      const chunks = [
        { type: "start", from: "AGENT", payload: { messageId: "sup" } },
        // A custom tool piping an agent's stream into its writer: Mastra's
        // delegation tools are `agent-<name>`, this one is not.
        forwarded("research", "AGENT", "one"),
        forwarded("research", "AGENT", "two"),
        // A source Mastra does not define.
        forwarded("agent-researcher", "ROBOT", "three"),
        forwarded("agent-researcher", "ROBOT", "four"),
        { type: "finish", from: "AGENT", payload: { messageId: "sup" } },
      ];
      const events = await collectEvents(
        make(chunks, attributed).agent,
        FIRST_TURN,
      );
      expect(events.map((event) => event.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.RUN_FINISHED,
      ]);
      const warnings = warn.mock.calls.map((args) => String(args[0]));
      expect(
        warnings.filter((w) => w.includes("forwarded by tool research")),
      ).toHaveLength(1);
      expect(warnings.filter((w) => w.includes("from=ROBOT"))).toHaveLength(1);
    });
  },
);
