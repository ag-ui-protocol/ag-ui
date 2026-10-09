import type {
  Actor,
  Agent,
  AgentEvent,
  AgentEventStreamFrame,
  AgentInteraction,
  OmnaraApi,
  ToolCall,
} from "../api";

type Call = { method: string; args: unknown[] };
type Block = Record<string, unknown> & { type: string };

/** An Omnara error as the SDK throws it. */
export class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`fake ${status}`);
  }
}

const LAUNCH_SOURCE = `version: v1
instruction: test
model: { provider_config: p, name: m }
tools:
  profile_tool: { type: custom, description: From the profile, input_schema: { type: object } }
`;

/**
 * In-memory Omnara: one agent, an ordered log, live frames, and scripted
 * reactions to what the adapter submits.
 */
export class FakeOmnara implements OmnaraApi {
  readonly calls: Call[] = [];
  readonly events: AgentEvent[] = [];
  agent: Agent = {
    id: "agt_1",
    org_id: "org",
    project_id: "proj",
    state: "active",
    name: "a",
    current_config_id: "acfg_launch",
    created_at: "",
    updated_at: "",
  };
  readonly configs = new Map<string, string>([["acfg_launch", LAUNCH_SOURCE]]);
  readyCalls: ToolCall[] = [];
  interactions: AgentInteraction[] = [];
  children: Agent[] = [];
  /** Inputs stored but not yet started. */
  backlog: Array<{ id: string; input_idempotency_key?: string }> = [];
  /** Accepts inputs but cancels them before they start (from Omnara's dashboard, say). */
  cancelInputs = false;
  /** Accepts the next input but loses the response (a timeout, say). */
  loseNextInputResponse = false;
  actors = new Map<string, Actor>();
  /** Fails the named method once with this status (and Omnara error code). */
  failNext = new Map<string, number | [number, string]>();
  /** Scripted reactions. */
  onInput?: (text: string, key: string) => void;
  onResult?: (toolCallId: string) => void;
  onResolve?: (interactionId: string) => void;

  /** Launch keys seen: the first launch with a key creates the agent. */
  private readonly launchKeys = new Set<string>();
  private nextId = 0;
  /** Accepted inputs' content, by idempotency key. */
  private readonly inputs = new Map<string, string>();
  private readonly listeners = new Set<
    (frame: AgentEventStreamFrame) => void
  >();

  constructor() {
    this.push({
      event_kind: "agent_input",
      input_kind: "config_change",
      agent_config_id: "acfg_launch",
      content_blocks: [],
    });
  }

  // ------------------------------------------------------------- scripting

  id(prefix: string): string {
    return `${prefix}_${++this.nextId}`;
  }

  push(partial: Record<string, unknown>): AgentEvent {
    const event = {
      id: this.id("evt"),
      agent_id: this.agent.id,
      turn_id: "trn",
      turn_sequence: 0,
      is_opening_event: false,
      created_at: "",
      ...partial,
      sequence: this.events.length + 1,
      ...(partial.event_kind === "agent_input"
        ? { agent_input_id: partial.agent_input_id ?? this.id("ain") }
        : {}),
    } as unknown as AgentEvent;
    this.events.push(event);
    this.emit(event as AgentEventStreamFrame);
    return event;
  }

  output(mcc: string, blocks: Block[], stop = "end_turn"): AgentEvent {
    return this.push({
      event_kind: "model_output",
      model_call_context_id: mcc,
      stop_reason: stop,
      content_blocks: blocks,
    });
  }

  result(toolCallId: string, text: string, outcome = "succeeded"): AgentEvent {
    return this.push({
      event_kind: "tool_result",
      tool_call_id: toolCallId,
      outcome,
      content_blocks: [{ type: "text", text }],
    });
  }

  delta(mcc: string, seq: number, event: Record<string, unknown>): void {
    this.emit({
      turn_id: "trn",
      model_call_context_id: mcc,
      seq,
      source_seq_start: seq,
      source_seq_end: seq,
      coalesced_count: 1,
      event,
    } as AgentEventStreamFrame);
  }

  update(toolCallId: string, state: string): void {
    this.emit({
      tool_call_id: toolCallId,
      agent_id: this.agent.id,
      state,
    } as AgentEventStreamFrame);
  }

  /** A custom call the agent waits on. */
  readyCall(id: string, name: string, agentId = this.agent.id): ToolCall {
    const call = {
      id,
      agent_id: agentId,
      turn_id: "trn",
      provider_call_id: id,
      name,
      input: {},
      type: "custom",
      state: "ready",
      created_at: "",
    } as ToolCall;
    this.readyCalls.push(call);
    return call;
  }

  interaction(
    id: string,
    kind: "permission" | "question",
    toolCallId: string,
    options = ["Allow", "Deny"],
  ): AgentInteraction {
    const interaction = {
      id,
      org_id: "org",
      project_id: "proj",
      agent_id: this.agent.id,
      tool_call_id: toolCallId,
      interaction_kind: kind,
      state: "open",
      request: {
        title: "Title",
        questions: [
          {
            prompt: "Q",
            options: options.map((label, i) => ({
              label,
              ...(i === options.length - 1 && kind === "question"
                ? { allows_text: true }
                : {}),
            })),
          },
        ],
      },
      created_at: "",
    } as AgentInteraction;
    this.interactions.push(interaction);
    return interaction;
  }

  /** Run `fn` after the adapter's current call returns, like Omnara reacting asynchronously. */
  later(fn: () => void): void {
    setTimeout(fn, 5);
  }

  called(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  private emit(frame: AgentEventStreamFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failNext.get(method);
    if (failure !== undefined) {
      this.failNext.delete(method);
      throw Array.isArray(failure)
        ? new FakeApiError(failure[0], failure[1])
        : new FakeApiError(failure);
    }
  }

  // ------------------------------------------------------------- OmnaraApi

  async createConfig(source: string, format: "yaml" | "json") {
    this.record("createConfig", [source, format]);
    return { id: "acfg_launch" };
  }
  async getConfig(configId: string) {
    this.record("getConfig", [configId]);
    return { id: configId, source: this.configs.get(configId) } as never;
  }
  async getProfile(idOrName: string) {
    this.record("getProfile", [idOrName]);
    return { id: "aprf_1", current_config_id: "acfg_launch" };
  }
  async launch(body: unknown, key: string) {
    this.record("launch", [body, key]);
    // Omnara's agent-name rules: at most 64 characters, no edge or invisible spaces.
    const name = (body as { name: string }).name;
    if (
      [...name].length > 64 ||
      /^\s|\s$|[^\S ]|[\p{Cc}\p{Cf}\p{Cs}\p{Variation_Selector}\uFFFD\u2800]/u.test(
        name,
      )
    )
      throw new FakeApiError(400);
    const created = !this.launchKeys.has(key);
    this.launchKeys.add(key);
    return { agent: this.agent, created };
  }
  async listChildren(agentId: string) {
    this.record("listChildren", [agentId]);
    return this.children.filter(
      (c) => (c.parent_agent_id ?? this.agent.id) === agentId,
    );
  }
  async setConfig(
    agentId: string,
    source: string,
    format: string,
    expected: string,
  ) {
    this.record("setConfig", [agentId, source, format, expected]);
    const id = this.id("acfg");
    this.configs.set(id, source);
    this.agent = { ...this.agent, current_config_id: id };
    this.push({
      event_kind: "agent_input",
      input_kind: "config_change",
      agent_config_id: id,
      content_blocks: [],
    });
  }
  async listEvents(agentId: string) {
    this.record("listEvents", [agentId]);
    return [...this.events];
  }
  async hasEventsAfter(agentId: string, sequence: number) {
    this.record("hasEventsAfter", [agentId, sequence]);
    return this.events.some((e) => e.sequence > sequence);
  }
  async listBacklog(agentId: string) {
    this.record("listBacklog", [agentId]);
    return [...this.backlog];
  }
  async postInput(
    agentId: string,
    body: { content_blocks: Block[] },
    key: string,
  ) {
    this.record("postInput", [agentId, body, key]);
    // A repeated key returns the existing input (no new event); other content conflicts.
    const content = JSON.stringify(body.content_blocks);
    const existing = this.inputs.get(key);
    if (existing !== undefined) {
      if (existing !== content) throw new FakeApiError(409);
      return;
    }
    this.inputs.set(key, content);
    if (this.cancelInputs) return;
    const text = body.content_blocks
      .filter(
        (b) =>
          b.type === "text" &&
          !(b.metadata as Record<string, string> | undefined)?.omnara_hidden,
      )
      .map((b) => b.text)
      .join("");
    // Queued until it starts; starting moves it into the log in one step.
    const queued = { id: this.id("ain"), input_idempotency_key: key };
    this.backlog.push(queued);
    this.later(() => {
      this.backlog = this.backlog.filter((i) => i !== queued);
      this.push({
        event_kind: "agent_input",
        input_kind: "content",
        agent_input_id: queued.id,
        input_idempotency_key: key,
        content_blocks: body.content_blocks,
        is_opening_event: true,
      });
      this.onInput?.(text, key);
    });
    if (this.loseNextInputResponse) {
      this.loseNextInputResponse = false;
      throw new FakeApiError(504);
    }
  }
  stream(
    agentId: string,
    afterSequence: number,
    signal: AbortSignal,
    onConnected: () => void,
  ): AsyncIterable<AgentEventStreamFrame> {
    const queue: AgentEventStreamFrame[] = this.events.filter(
      (e) => e.sequence > afterSequence,
    ) as AgentEventStreamFrame[];
    let wake: (() => void) | undefined;
    const listener = (frame: AgentEventStreamFrame) => {
      queue.push(frame);
      wake?.();
    };
    const listeners = this.listeners;
    return {
      async *[Symbol.asyncIterator]() {
        listeners.add(listener);
        onConnected();
        try {
          while (!signal.aborted) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        } finally {
          listeners.delete(listener);
        }
      },
    };
  }
  async readyCustomCalls(agentId: string) {
    this.record("readyCustomCalls", [agentId]);
    return [...this.readyCalls];
  }
  async openInteractions(agentId: string) {
    this.record("openInteractions", [agentId]);
    return [...this.interactions];
  }
  async submitResult(
    agentId: string,
    toolCallId: string,
    outcome: string,
    content: Block[],
  ) {
    this.record("submitResult", [agentId, toolCallId, outcome, content]);
    this.readyCalls = this.readyCalls.filter((c) => c.id !== toolCallId);
    this.later(() => {
      this.result(toolCallId, String(content[0]?.text ?? ""), outcome);
      this.onResult?.(toolCallId);
    });
  }
  async resolveInteraction(
    agentId: string,
    interactionId: string,
    answers: unknown,
    actor: unknown,
  ) {
    this.record("resolveInteraction", [agentId, interactionId, answers, actor]);
    this.interactions = this.interactions.filter((i) => i.id !== interactionId);
    this.later(() => this.onResolve?.(interactionId));
  }
  async cancel(agentId: string, actor: unknown) {
    this.record("cancel", [agentId, actor]);
    if (agentId !== this.agent.id) return;
    const cancelled = this.readyCalls.filter((c) => c.agent_id === agentId);
    this.readyCalls = this.readyCalls.filter((c) => c.agent_id !== agentId);
    this.push({
      event_kind: "agent_input",
      input_kind: "control",
      control_type: "cancel_current",
      content_blocks: [],
    });
    for (const c of cancelled) this.result(c.id, "canceled", "canceled");
  }
  async getActor(actorId: string) {
    this.record("getActor", [actorId]);
    const actor = this.actors.get(actorId);
    if (!actor) throw new FakeApiError(404);
    return actor;
  }
}
