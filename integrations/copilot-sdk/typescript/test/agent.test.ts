import { describe, expect, it } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { CopilotAgent, type CopilotClientPort, type CopilotSessionPort } from "../src/index.js";

type Payload = { id: string; type: string; data?: Record<string, unknown> };

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
  constructor(
    private readonly script: Payload[],
    private readonly stall = false,
  ) {}
  async createSession(config: { onEvent?: (event: never) => void }): Promise<CopilotSessionPort> {
    this.session = new FakeSession(config.onEvent!, this.script, this.stall);
    return this.session as unknown as CopilotSessionPort;
  }
}

class FakeSession {
  sessionId = "fake-session";
  prompts: string[] = [];
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
  async send(): Promise<void> {
    this.prompts.push("sent");
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
});
