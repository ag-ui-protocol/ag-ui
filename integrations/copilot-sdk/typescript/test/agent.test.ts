import { describe, expect, it, vi } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { CopilotAgent, type CopilotClientPort, type CopilotSessionPort } from "../src/index.js";
import { CopilotEventMapper } from "../src/mapper.js";

type Payload = { id: string; type: string; agentId?: string; data?: Record<string, unknown> };

const TEXT_TURN: Payload[] = [
  { id: "1", type: "assistant.message_start", data: { messageId: "m1" } },
  { id: "2", type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hello" } },
  { id: "3", type: "assistant.message", data: { messageId: "m1", content: "Hello there", toolRequests: [] } },
  { id: "4", type: "session.idle", data: {} },
];

const FRONTEND_TOOL_TURN: Payload[] = [
  {
    id: "1",
    type: "external_tool.requested",
    data: {
      toolCallId: "call-1",
      requestId: "req-1",
      toolName: "change_background",
      arguments: { color: "red" },
    },
  },
];

class FakeClient implements CopilotClientPort {
  session?: FakeSession;
  config?: SessionConfig;
  constructor(
    private readonly script: Payload[],
    private readonly stall = false,
  ) {}
  async createSession(config: SessionConfig): Promise<CopilotSessionPort> {
    this.config = config;
    this.session = new FakeSession(config.onEvent!, this.script, this.stall);
    return this.session as unknown as CopilotSessionPort;
  }
}

class FakeSession {
  sessionId = "fake-session";
  prompts: string[] = [];
  sent: Parameters<CopilotSessionPort["send"]>[0][] = [];
  resolved: string[] = [];
  aborted = false;
  rpc = {
    tools: {
      handlePendingToolCall: async ({ requestId, result }: { requestId: string; result: unknown }) => {
        this.resolved.push(requestId);
        this.lastResult = result;
        this.emit({ id: `done-${requestId}`, type: "session.idle", data: {} });
        return { success: true };
      },
    },
  };
  lastResult: unknown;
  constructor(
    private readonly onEvent: (event: never) => void,
    private readonly script: Payload[],
    private readonly stall: boolean,
  ) {}
  emit(payload: Payload): void {
    this.onEvent(payload as never);
  }
  async send(options: Parameters<CopilotSessionPort["send"]>[0]): Promise<void> {
    this.prompts.push(options.prompt);
    this.sent.push(options);
    if (this.stall) await new Promise(() => {});
    for (const payload of this.script) this.emit(payload);
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  async disconnect(): Promise<void> {}
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "u1", role: "user", content: "Say hello." }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}

const run = (agent: CopilotAgent, input: RunAgentInput): Promise<BaseEvent[]> =>
  firstValueFrom(agent.run(input).pipe(toArray()));

const TOOLS = [
  { name: "change_background", description: "change it", parameters: { type: "object", properties: {} } },
];

describe("CopilotAgent", () => {
  it("streams assistant text", async () => {
    const events = await run(new CopilotAgent({ client: new FakeClient(TEXT_TURN) }), makeInput());
    expect(events[0]!.type).toBe("RUN_STARTED");
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello there");
  });

  it("forwards RunAgentInput.context and state into the prompt", async () => {
    const client = new FakeClient(TEXT_TURN);
    let prompt = "";
    const agent = new CopilotAgent({ client });
    const original = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = (await original(config)) as unknown as FakeSession;
      session.send = async ({ prompt: value }: { prompt: string }) => {
        prompt = value;
        for (const payload of TEXT_TURN) session.emit(payload);
      };
      return session as unknown as CopilotSessionPort;
    };
    await run(
      agent,
      makeInput({
        context: [{ description: "user name", value: "Ada" }],
        state: { theme: "dark" },
      }),
    );
    expect(prompt).toContain("user name: Ada");
    expect(prompt).toContain('"theme": "dark"');
    expect(prompt.endsWith("Say hello.")).toBe(true);
  });

  it("hands off a frontend tool and resolves the original pending request", async () => {
    const client = new FakeClient(FRONTEND_TOOL_TURN);
    const agent = new CopilotAgent({ client, runTimeoutMs: 5_000 });

    const first = await run(agent, makeInput({ tools: TOOLS } as Partial<RunAgentInput>));
    expect(first.at(-1)!.type).toBe("RUN_FINISHED");
    expect(first.some((event) => event.type === "TOOL_CALL_START")).toBe(true);

    const second = await run(
      agent,
      makeInput({
        runId: "r2",
        tools: TOOLS,
        messages: [
          { id: "u1", role: "user", content: "Say hello." },
          { id: "t-1", role: "tool", toolCallId: "call-1", content: "ok" },
        ],
      } as Partial<RunAgentInput>),
    );
    expect(second.at(-1)!.type).toBe("RUN_FINISHED");
    // Resolved by native requestId, never re-prompted as user text.
    expect(client.session!.resolved).toEqual(["req-1"]);
    expect(client.session!.prompts).toHaveLength(1);
  });

  it("forwards a frontend tool error as a failure result", async () => {
    const client = new FakeClient(FRONTEND_TOOL_TURN);
    const agent = new CopilotAgent({ client, runTimeoutMs: 5_000 });
    await run(agent, makeInput({ tools: TOOLS } as Partial<RunAgentInput>));
    await run(
      agent,
      makeInput({
        runId: "r2",
        tools: TOOLS,
        messages: [
          { id: "u1", role: "user", content: "Say hello." },
          { id: "t-1", role: "tool", toolCallId: "call-1", content: "nope", error: "browser refused" },
        ],
      } as Partial<RunAgentInput>),
    );
    expect(client.session!.lastResult).toMatchObject({
      resultType: "failure",
      error: "browser refused",
    });
  });

  it("ends the run instead of awaiting a wedged native call", async () => {
    const client = new FakeClient(TEXT_TURN, true);
    const agent = new CopilotAgent({ client, runTimeoutMs: 100 });
    const events = await run(agent, makeInput());
    expect(events.at(-1)!.type).toBe("RUN_ERROR");
    expect(client.session!.aborted).toBe(true);
  });

  it.each([
    ["tool.execution_start", true], ["external_tool.requested", true],
    ["tool.execution_start", false], ["external_tool.requested", false],
  ] as const)(
    "streams args once before %s, with a no-stream fallback (name first: %s)",
    (type, nameFirst) => {
      const mapper = new CopilotEventMapper();
      const chunks = ['{"color":', '"red"}'];
      const streamed = chunks.flatMap((inputDelta, index) => {
        const events = mapper.mapEvent({
          id: `delta-${index}`, type: "assistant.tool_call_delta",
          data: { toolCallId: "call-1", ...(index === (nameFirst ? 0 : 1) ? { toolName: "paint" } : {}), inputDelta },
        } as SessionEvent);
        if (!nameFirst && index === 0) expect(events).toEqual([]);
        return events;
      });
      expect(streamed).toEqual([
        { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "paint" },
        ...(nameFirst ? chunks : [chunks.join("")]).map((delta) => ({ type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta })),
      ]);
      const data = { toolCallId: "call-1", toolName: "paint", requestId: "req-1", arguments: { color: "red" } };
      expect(mapper.mapEvent({ id: "end", type, data } as SessionEvent)).toEqual([
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ]);
      expect(mapper.mapEvent({
        id: "final-message", type: "assistant.message",
        data: { messageId: "m1", content: "", toolRequests: [{ toolCallId: "call-1", name: "paint", arguments: data.arguments }] },
      } as SessionEvent)).toEqual([]);
      expect(mapper.mapEvent({
        id: "fallback", type, data: { ...data, toolCallId: "call-2", requestId: "req-2" },
      } as SessionEvent)).toEqual([
        { type: "TOOL_CALL_START", toolCallId: "call-2", toolCallName: "paint" },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-2", delta: '{"color":"red"}' },
        { type: "TOOL_CALL_END", toolCallId: "call-2" },
      ]);
      expect(mapper.finish()).toEqual([]);
    },
  );

  it("maps subagent lifecycle and tags its message and tool events", async () => {
    const child = { toolCallId: "spawn-1", agentName: "research", agentDisplayName: "Research", agentDescription: "Find facts", parentId: "parent-agent" };
    const script: Payload[] = [
      { type: "subagent.started", agentId: "parent-agent", data: { toolCallId: "spawn-parent", agentName: "coordinator", agentDisplayName: "Coordinator", agentDescription: "Coordinate", parentId: "unknown-task-registry-id" } },
      { type: "subagent.started", data: child },
      { type: "session.idle", data: {} },
      { type: "assistant.message_delta", data: { messageId: "child-message", deltaContent: "Found it" } },
      { type: "assistant.message", data: { messageId: "child-message", content: "Found it", toolRequests: [] } },
      { type: "assistant.tool_call_delta", data: { toolCallId: "child-tool", toolName: "lookup", inputDelta: "{}" } },
      { type: "tool.execution_start", data: { toolCallId: "child-tool", toolName: "lookup", arguments: {} } },
      { type: "tool.execution_complete", data: { toolCallId: "child-tool", success: true, result: { content: "found" } } },
      { type: "subagent.completed", data: child },
      { type: "subagent.started", agentId: "child-2", data: { ...child, toolCallId: "spawn-2" } },
      { type: "subagent.failed", agentId: "child-2", data: { ...child, toolCallId: "spawn-2", error: "Lookup failed" } },
      { type: "subagent.completed", agentId: "parent-agent", data: { toolCallId: "spawn-parent", agentName: "coordinator", agentDisplayName: "Coordinator" } },
    ].map((event, index) => ({ id: String(index), agentId: "child-1", ...event }));
    script.push({ id: "root-idle", type: "session.idle", data: {} });
    const events = await run(new CopilotAgent({ client: new FakeClient(script), runTimeoutMs: 1_000 }), makeInput());
    const lifecycle = events.filter((event) => event.type.startsWith("SUBAGENT_"));
    expect(lifecycle).toMatchObject([
      { type: "SUBAGENT_STARTED", subagentRunId: "parent-agent", parentToolCallId: "spawn-parent" },
      { type: "SUBAGENT_STARTED", subagentRunId: "child-1", parentToolCallId: "spawn-1", parentSubagentRunId: "parent-agent", name: "Research" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1", outcome: { type: "success" } },
      { type: "SUBAGENT_STARTED", subagentRunId: "child-2", parentToolCallId: "spawn-2" },
      { type: "SUBAGENT_ERROR", subagentRunId: "child-2", message: "Lookup failed" },
      { type: "SUBAGENT_FINISHED", subagentRunId: "parent-agent", outcome: { type: "success" } },
    ]);
    expect(lifecycle[1]).not.toHaveProperty("toolCallId");
    expect(lifecycle[0]).not.toHaveProperty("parentSubagentRunId", "unknown-task-registry-id");
    const tagged = events.filter((event) => /^(TEXT_MESSAGE_|TOOL_CALL_)/.test(event.type));
    expect(tagged).toHaveLength(7);
    for (const event of tagged) expect(event).toHaveProperty("subagentRunId", "child-1");
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");

    const mapper = new CopilotEventMapper();
    const started = mapper.mapEvent({
      id: "paused-child", type: "subagent.started", agentId: "child-1", data: child,
    } as SessionEvent);
    expect(mapper.suspend()).toEqual([
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1", outcome: { type: "suspended" } },
    ]);
    expect(mapper.resume()).toEqual(started);
    expect(mapper.resume()).toEqual([]);
    expect(mapper.mapEvent({
      id: "completed-child", type: "subagent.completed", agentId: "child-1", data: child,
    } as SessionEvent)).toEqual([
      { type: "SUBAGENT_FINISHED", subagentRunId: "child-1", outcome: { type: "success" } },
    ]);
    expect(mapper.suspend()).toEqual([]);
  });

  it.each([true, false])("sends inline image and legacy binary blobs (with text: %s)", async (withText) => {
    const client = new FakeClient(TEXT_TURN);
    const events = await run(new CopilotAgent({ client }), makeInput({
      messages: [{
        id: "image-user", role: "user", content: [
          ...(withText ? [{ type: "text" as const, text: "Describe these." }] : []),
          { type: "image", source: { type: "data", value: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" } },
          { type: "binary", data: "d29ybGQ=", mimeType: "image/jpeg" },
        ],
      }],
    }));
    expect(client.session!.sent).toHaveLength(1);
    expect(client.session!.sent[0]!.attachments).toEqual([
      { type: "blob", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "blob", data: "d29ybGQ=", mimeType: "image/jpeg" },
    ]);
    if (withText) expect(client.session!.sent[0]!.prompt).toBe("Describe these.");
    else expect(client.session!.sent[0]!.prompt).toBe("Describe the attached media.");
    expect(events.at(-1)!.type).toBe("RUN_FINISHED");
  });

  it("emits PredictState and immutable snapshots across mutable backend handler steps", async () => {
    const predictState = [{ state_key: "theme", tool: "set_theme", tool_argument: "theme" }];
    const seenStates: unknown[] = [];
    const client = new FakeClient([{ id: "idle", type: "session.idle", data: {} }]);
    const create = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = await create(config);
      const send = session.send.bind(session);
      session.send = async (options) => {
        for (const theme of ["light", "contrast"]) {
          const args = { theme };
          await config.tools![0]!.handler!(args, {
            sessionId: session.sessionId, toolCallId: `backend-${theme}`, toolName: "set_theme", arguments: args,
          });
        }
        return send(options);
      };
      return session;
    };
    const agent = new CopilotAgent({
      client, predictState,
      tools: [{
        name: "set_theme", description: "Update theme", parameters: { type: "object" },
        handler: (args, context) => {
          const state = context.state as { theme: { history: string[] } };
          seenStates.push(structuredClone(state));
          state.theme.history.push(args.theme);
          context.setState(state);
          state.theme.history.push("unpublished");
          return "updated";
        },
      }],
    });
    const events = await run(agent, makeInput({ state: { theme: { history: ["dark"] } } }));
    expect(client.config!.tools![0]!.skipPermission ?? false).toBe(false);
    expect(seenStates).toEqual([
      { theme: { history: ["dark"] } },
      { theme: { history: ["dark", "light"] } },
    ]);
    expect(events).toEqual([
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "CUSTOM", name: "PredictState", value: predictState },
      { type: "STATE_SNAPSHOT", snapshot: { theme: { history: ["dark", "light"] } } },
      { type: "STATE_SNAPSHOT", snapshot: { theme: { history: ["dark", "light", "contrast"] } } },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
    ]);
  });

  it.each(["tool", "resume", "error"])("resumes an interrupt through the original native request (%s)", async (mode) => {
    const client = new FakeClient(FRONTEND_TOOL_TURN.map((event) => ({ ...event, agentId: "approval-agent" })));
    const resume = vi.fn((answer: unknown, args: unknown) => ({ answer, args }));
    const agent = new CopilotAgent({
      client, tools: TOOLS, interrupts: { change_background: resume }, runTimeoutMs: 5_000,
    });
    const first = await run(agent, makeInput());
    expect(client.config!.tools![0]!.handler).toBeUndefined();
    expect(client.config!.tools![0]!.skipPermission).toBe(true);
    expect(first.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt", interrupts: [{
        id: "call-1", reason: "tool_call", toolCallId: "call-1",
        subagentRunId: "approval-agent", metadata: { reason: { color: "red" } },
      }] },
    });
    const answer = { approved: true };
    const second = await run(agent, makeInput({
      runId: "r2",
      ...(mode === "resume"
        ? { resume: [{ interruptId: "call-1", status: "resolved", payload: answer }] }
        : { messages: [
          ...makeInput().messages,
          { id: "answer", role: "tool", toolCallId: "call-1",
            content: mode === "error" ? "unavailable" : JSON.stringify(answer),
            ...(mode === "error" ? { error: "browser refused" } : {}) },
        ] }),
    }));
    expect(second.at(-1)!.type).toBe("RUN_FINISHED");
    expect(client.session!.resolved).toEqual(["req-1"]);
    expect(client.session!.prompts).toHaveLength(1);
    if (mode === "error") {
      expect(client.session!.lastResult).toEqual({
        textResultForLlm: "unavailable", resultType: "failure", error: "browser refused",
      });
    } else {
      expect(resume).toHaveBeenCalledExactlyOnceWith(answer, { color: "red" });
      expect(JSON.parse(client.session!.lastResult as string)).toEqual({ answer, args: { color: "red" } });
    }
  });
});
