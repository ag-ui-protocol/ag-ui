import { firstValueFrom, toArray } from "rxjs";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import type { ResumeSessionConfig, SessionConfig } from "@github/copilot-sdk";
import { CopilotAgent, type CopilotClientPort, type CopilotSessionPort } from "../src/index.js";

export type Payload = { id: string; type: string; agentId?: string; data?: Record<string, unknown> };

export const TEXT_TURN: Payload[] = [
  { id: "1", type: "assistant.message_start", data: { messageId: "m1" } },
  { id: "2", type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hello" } },
  { id: "3", type: "assistant.message", data: { messageId: "m1", content: "Hello there", toolRequests: [] } },
  { id: "4", type: "session.idle", data: {} },
];

export const FRONTEND_TOOL_TURN: Payload[] = [
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

export class FakeClient implements CopilotClientPort {
  session?: FakeSession;
  config?: SessionConfig;
  /** Session ids the fake runtime has persisted, as the CLI does on disk. */
  readonly stored = new Set<string>();
  readonly resumed: string[] = [];
  constructor(
    private readonly script: Payload[],
    private readonly stall = false,
  ) {}
  async createSession(config: SessionConfig): Promise<CopilotSessionPort> {
    if (config.sessionId) this.stored.add(config.sessionId);
    return this.open(config);
  }
  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSessionPort> {
    this.resumed.push(sessionId);
    return this.open(config);
  }
  async getSessionMetadata(sessionId: string): Promise<unknown> {
    return this.stored.has(sessionId) ? { sessionId } : undefined;
  }
  private open(config: SessionConfig | ResumeSessionConfig): CopilotSessionPort {
    this.config = config as SessionConfig;
    this.session = new FakeSession(config.onEvent!, this.script, this.stall);
    return this.session as unknown as CopilotSessionPort;
  }
}

export class FakeSession {
  sessionId = "fake-session";
  prompts: string[] = [];
  sent: Parameters<CopilotSessionPort["send"]>[0][] = [];
  resolved: string[] = [];
  aborted = false;
  disconnected = false;
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
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
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

export const run = (agent: CopilotAgent, input: RunAgentInput): Promise<BaseEvent[]> =>
  firstValueFrom(agent.run(input).pipe(toArray()));

export const TOOLS = [
  { name: "change_background", description: "change it", parameters: { type: "object", properties: {} } },
];
