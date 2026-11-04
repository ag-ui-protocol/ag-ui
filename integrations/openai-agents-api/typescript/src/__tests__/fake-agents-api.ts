import type OpenAI from "openai";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { OpenAIAgentsAgent } from "../agent";
import type {
  AgentSession,
  OpenAIAgentsAgentConfig,
  RequiredAction,
  SessionEvent,
  SessionInputEvent,
} from "../types";

type Script = (fake: FakeAgentsApi) => void;

/** A live event stream the fake pushes into until the client aborts it. */
class FakeStream implements AsyncIterable<SessionEvent> {
  private items: SessionEvent[] = [];
  private waiter: ((value: IteratorResult<SessionEvent>) => void) | undefined;
  private closed = false;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  push(event: SessionEvent): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: event, done: false });
    } else {
      this.items.push(event);
    }
  }

  close(): void {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

let counter = 0;
const id = (prefix: string) => `${prefix}_${++counter}`;

/**
 * A scripted stand-in for `client.beta.agents.sessions`. Tests describe what
 * the "server" does when a session is created or input is submitted, and the
 * fake keeps session status / required actions in step with the events it
 * emits, like the real API.
 */
export class FakeAgentsApi {
  readonly sessions = new Map<string, AgentSession>();
  readonly creates: Array<Record<string, unknown>> = [];
  readonly updates: Array<{
    sessionId: string;
    body: Record<string, unknown>;
  }> = [];
  readonly submissions: SessionInputEvent[][] = [];
  /** Events the stream replays on connect (the active turn), per session. */
  readonly replay = new Map<string, SessionEvent[]>();
  private streams = new Map<string, FakeStream>();

  onCreate: (sessionId: string, params: Record<string, unknown>) => void =
    () => {};
  onSubmit: (sessionId: string, events: SessionInputEvent[]) => void = () => {};

  readonly client = {
    beta: {
      agents: {
        retrieve: async () => ({ tools: [] }),
        sessions: {
          create: async (
            params: Record<string, unknown>,
            options?: { signal?: AbortSignal },
          ) => {
            this.creates.push(params);
            const sessionId = id("sess");
            this.sessions.set(sessionId, this.blankSession(sessionId));
            const stream = new FakeStream(options?.signal);
            this.streams.set(sessionId, stream);
            this.emit(sessionId, {
              type: "agent.session.created",
              event_id: id("evt"),
              session: this.session(sessionId),
            } as SessionEvent);
            queueMicrotask(() => this.onCreate(sessionId, params));
            return stream;
          },
          retrieve: async (sessionId: string) => {
            const session = this.sessions.get(sessionId);
            if (!session)
              throw Object.assign(new Error("404 not found"), { status: 404 });
            return structuredClone(session);
          },
          update: async (sessionId: string, body: Record<string, unknown>) => {
            this.updates.push({ sessionId, body });
            return structuredClone(this.session(sessionId));
          },
          events: {
            stream: async (
              sessionId: string,
              options?: { signal?: AbortSignal },
            ) => {
              const stream = new FakeStream(options?.signal);
              this.streams.set(sessionId, stream);
              for (const event of this.replay.get(sessionId) ?? [])
                stream.push(event);
              return stream;
            },
            create: async (
              sessionId: string,
              body: { events: SessionInputEvent[] },
              options?: { signal?: AbortSignal },
            ) => {
              if (options?.signal?.aborted)
                throw Object.assign(new Error("Request was aborted."), {
                  name: "AbortError",
                });
              this.submissions.push(body.events);
              queueMicrotask(() => this.onSubmit(sessionId, body.events));
            },
          },
        },
      },
    },
  } as unknown as OpenAI;

  private blankSession(sessionId: string): AgentSession {
    return {
      id: sessionId,
      object: "agent.session",
      status: "in_progress",
      required_actions: [],
      error: null,
    } as unknown as AgentSession;
  }

  session(sessionId: string): AgentSession {
    return this.sessions.get(sessionId)!;
  }

  /** Pushes an event to the session's open stream, updating session state like the API does. */
  emit(sessionId: string, event: SessionEvent): void {
    const session = this.session(sessionId);
    if (event.type === "agent.session.requires_action") {
      session.status = "requires_action";
      session.required_actions = event.session.required_actions;
    } else if (event.type === "agent.session.idle") {
      session.status = "idle";
      session.required_actions = [];
    } else if (event.type === "agent.session.in_progress") {
      session.status = "in_progress";
      session.required_actions = [];
    }
    this.streams.get(sessionId)?.push(event);
  }

  // --- Event builders -------------------------------------------------------

  turnId = "turn_1";

  text(
    sessionId: string,
    text: string,
    { stream = true }: { stream?: boolean } = {},
  ): string {
    const itemId = id("msg");
    const base = {
      event_id: id("evt"),
      session_id: sessionId,
      turn_id: this.turnId,
      output_index: 0,
    };
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.item.added",
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [],
        status: "in_progress",
        phase: "final_answer",
        turn_id: this.turnId,
      },
    } as unknown as SessionEvent);
    if (stream) {
      for (const delta of text.match(/.{1,4}/g) ?? []) {
        this.emit(sessionId, {
          ...base,
          type: "agent.session.turn.output_text.delta",
          item_id: itemId,
          content_index: 0,
          delta,
        } as SessionEvent);
      }
    }
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.output_text.done",
      item_id: itemId,
      content_index: 0,
      text,
    } as SessionEvent);
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.item.done",
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed",
        phase: "final_answer",
        turn_id: this.turnId,
      },
    } as unknown as SessionEvent);
    return itemId;
  }

  reasoning(sessionId: string, summary: string): void {
    const itemId = id("rs");
    const base = {
      event_id: id("evt"),
      session_id: sessionId,
      turn_id: this.turnId,
      output_index: 0,
    };
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.item.added",
      item: {
        type: "reasoning",
        id: itemId,
        summary: [],
        status: "in_progress",
        turn_id: this.turnId,
      },
    } as unknown as SessionEvent);
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.reasoning_summary_part.added",
      item_id: itemId,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    } as SessionEvent);
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.reasoning_summary_text.delta",
      item_id: itemId,
      summary_index: 0,
      delta: summary,
    } as SessionEvent);
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.reasoning_summary_part.done",
      item_id: itemId,
      summary_index: 0,
      part: { type: "summary_text", text: summary },
      status: null,
    } as SessionEvent);
    this.emit(sessionId, {
      ...base,
      type: "agent.session.turn.item.done",
      item: {
        type: "reasoning",
        id: itemId,
        summary: [{ type: "summary_text", text: summary }],
        status: "completed",
        turn_id: this.turnId,
      },
    } as unknown as SessionEvent);
  }

  functionCallItem(
    sessionId: string,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): SessionEvent {
    return {
      type: "agent.session.turn.item.added",
      event_id: id("evt"),
      session_id: sessionId,
      turn_id: this.turnId,
      output_index: 1,
      item: {
        type: "function_call",
        id: callId,
        call_id: callId,
        name,
        arguments: args,
        status: "in_progress",
        turn_id: this.turnId,
      },
    } as unknown as SessionEvent;
  }

  /** The agent calls functions and waits for them. */
  callFunctions(
    sessionId: string,
    calls: Array<{
      callId: string;
      name: string;
      args: Record<string, unknown>;
    }>,
  ): void {
    for (const call of calls)
      this.emit(
        sessionId,
        this.functionCallItem(sessionId, call.callId, call.name, call.args),
      );
    const actions: RequiredAction[] = calls.map((call) => ({
      type: "function_call",
      turn_id: this.turnId,
      call_id: call.callId,
      name: call.name,
      arguments: call.args,
    }));
    this.emit(sessionId, {
      type: "agent.session.requires_action",
      event_id: id("evt"),
      session: {
        ...this.session(sessionId),
        status: "requires_action",
        required_actions: actions,
      },
    } as SessionEvent);
  }

  completeTurn(sessionId: string): void {
    this.emit(sessionId, {
      type: "agent.session.turn.completed",
      event_id: id("evt"),
      session_id: sessionId,
      turn_id: this.turnId,
      turn: {
        id: this.turnId,
        subagent_id: null,
        status: "completed",
        error: null,
      },
      usage: null,
    } as unknown as SessionEvent);
    this.emit(sessionId, {
      type: "agent.session.idle",
      event_id: id("evt"),
      session: { ...this.session(sessionId), status: "idle" },
    } as SessionEvent);
  }

  failTurn(sessionId: string, code: string, message: string): void {
    this.emit(sessionId, {
      type: "agent.session.turn.failed",
      event_id: id("evt"),
      session_id: sessionId,
      turn_id: this.turnId,
      turn: {
        id: this.turnId,
        subagent_id: null,
        status: "failed",
        error: { code, message },
      },
      usage: null,
    } as unknown as SessionEvent);
  }
}

export const makeAgent = (
  fake: FakeAgentsApi,
  config: Partial<OpenAIAgentsAgentConfig> = {},
) =>
  new OpenAIAgentsAgent({
    client: fake.client,
    agent: { model: "gpt-test", instructions: "Be helpful." },
    clientToolSettleMs: 20,
    onError: () => {},
    ...config,
  });

export const runInput = (
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput => ({
  threadId: "thread-1",
  runId: `run-${++counter}`,
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
  ...overrides,
});

/** Runs the agent to completion and returns every event it emitted. */
export const collect = (
  agent: OpenAIAgentsAgent,
  input: RunAgentInput,
): Promise<BaseEvent[]> =>
  new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });

export const types = (events: BaseEvent[]) => events.map((event) => event.type);

export type { Script };
