import {
  EventType,
  PROTOCOL_VERSION,
  type AGUIEvent,
  type BaseEvent,
  type Message,
  type ResumeEntry,
  type RunAgentInput,
  type RunFinishedOutcome,
  type ToolMessage,
  type UserMessage,
} from "@ag-ui/core";
import { createHash } from "node:crypto";
import {
  codeOf,
  statusOf,
  type Agent,
  type AgentEvent,
  type AgentEventStreamFrame,
  type CreateAgentInputContentBlock,
  type ExternalActorParams,
  type OmnaraApi,
  type ToolCall,
} from "./api";
import {
  MAX_CONTENT_BYTES,
  canonical,
  contentBytes,
  contextBlock,
  customTool,
  customToolNames,
  messageText,
  parseSource,
  pickToolShape,
  userBlocks,
  withoutMedia,
} from "./inputs";
import { answersFor, toInterrupt } from "./interrupts";
import {
  INPUT_KEY_PREFIX,
  clientIdOf,
  reasoningId,
  snapshotMessages,
  inputText,
  toolResultText,
  visibleText,
  type Author,
} from "./messages";
import type {
  BackendTool,
  OmnaraAgentConfig,
  OmnaraErrorContext,
} from "./types";

/** Stable `RUN_ERROR` codes. Upstream error text never reaches the client; it goes to `onError`. */
export const ERROR_MESSAGES = {
  thread_ended:
    "This chat's Omnara agent was archived. Start a new chat to continue.",
  invalid_tools: "Omnara rejected this chat's tools.",
  message_too_large:
    "This message is too large for Omnara. Start a new chat to continue.",
  run_failed: "The Omnara agent could not complete this request.",
  model_error: "The model failed to respond.",
} as const;
export type OmnaraErrorCode = keyof typeof ERROR_MESSAGES;

class RunError extends Error {
  constructor(
    readonly code: OmnaraErrorCode,
    readonly detail: unknown,
  ) {
    super(ERROR_MESSAGES[code]);
  }
}

const CONNECT_TIMEOUT_MS = 30_000;
const CHECK_INTERVAL_MS = 5_000;

const SUBAGENT_BROWSER_TOOL =
  "This tool runs in the user's browser; subagents can't use it.";
const RESULT_TOO_LARGE =
  "The result was too large to deliver (over Omnara's 1 MiB limit).";

interface RunDeps {
  api: OmnaraApi;
  config: OmnaraAgentConfig;
  backendTools: ReadonlyMap<string, BackendTool>;
  report: (error: unknown, context: OmnaraErrorContext) => Promise<void>;
}

type Ending = { outcome: RunFinishedOutcome } | { error: OmnaraErrorCode };
type Preview = {
  text: string;
  reasoning: Set<number>;
  next: number;
  broken: boolean;
};
type Work = {
  messages: UserMessage[];
  results: ToolMessage[];
  resume: ResumeEntry[];
};

/** One AG-UI request against one Omnara agent. */
export class OmnaraRun {
  private agentId?: string;
  private stopped = false;
  private detached = false;
  private readonly following = new AbortController();

  // What the tools look like: which custom tools are the page's (browser) tools.
  private launchCustomTools = new Set<string>();
  private readonly toolNames = new Map<
    string,
    { name: string; type: string }
  >();

  // Following.
  private readonly pendingKeys = new Set<string>();
  private submitted = false;
  private turnEnded = false;
  /** The turn was cancelled while this run followed it (someone pressed Stop elsewhere). */
  private cancelled = false;
  private lastSequence = 0;
  private modelError?: string;
  private readonly handledCalls = new Set<string>();
  private settled?: RunFinishedOutcome;
  /** A result Omnara didn't accept while following: ends the run with an error. */
  private failure?: unknown;
  private checking = false;
  private checkAgain = false;

  // Streaming.
  private openText?: string;
  private openReasoning?: string;
  private readonly previews = new Map<string, Preview>();
  private readonly authors = new Map<string, Promise<Author>>();

  constructor(
    private readonly deps: RunDeps,
    private readonly input: RunAgentInput,
    private readonly emitEvent: (event: BaseEvent) => void,
  ) {}

  /** Stop button: cancel the agent's current work and its running subagents, then end as cancelled. */
  stop(): void {
    this.stopped = true;
    this.following.abort();
  }

  /** The client went away: stop emitting, leave the agent running. */
  detach(): void {
    this.detached = true;
    this.following.abort();
  }

  async execute(): Promise<void> {
    const { threadId, runId } = this.input;
    this.emit({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      protocolVersion: PROTOCOL_VERSION,
    });
    let ending: Ending;
    try {
      ending = await this.drive();
    } catch (error) {
      if (this.detached) {
        await this.report("run_after_disconnect", error);
        return;
      }
      const code = error instanceof RunError ? error.code : "run_failed";
      await this.report(code, error instanceof RunError ? error.detail : error);
      ending = { error: code };
    }
    if (this.detached) return;
    this.closeOpen();
    await this.sendSnapshot();
    if ("error" in ending) {
      this.emit({
        type: EventType.RUN_ERROR,
        message: ERROR_MESSAGES[ending.error],
        code: ending.error,
      });
    } else if (
      ending.outcome.type === "success" &&
      this.modelError !== undefined
    ) {
      await this.report("model_error", new Error(this.modelError));
      this.emit({
        type: EventType.RUN_ERROR,
        message: ERROR_MESSAGES.model_error,
        code: "model_error",
      });
    } else {
      this.emit({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: ending.outcome,
      });
    }
  }

  private async drive(): Promise<Ending> {
    const agent = await this.findOrCreateAgent();
    if (this.stopped) return this.endStopped();
    const log = await this.deps.api.listEvents(agent.id);
    await this.syncTools(agent, log);
    for (const e of log) this.noteToolCalls(e);
    const work = this.newWork(log);

    if (!work.messages.length && !work.results.length && !work.resume.length) {
      // Nothing to submit: report what the agent is waiting on, if anything.
      const waiting = await this.waitingOutcome(agent.id);
      if (this.stopped) return this.endStopped();
      return { outcome: waiting ?? { type: "success" } };
    }

    await this.restoreOrder(log, work.messages);

    // Registered before the stream opens: a message already queued in Omnara
    // can start while earlier answers are submitted.
    for (const m of work.messages) this.pendingKeys.add(inputKey(m.id));
    const last = log.at(-1);
    // By the same rules as while following; a new agent has no turn under way.
    this.turnEnded = log.reduce((over, e) => turnOver(e, over), true);
    this.lastSequence = last?.sequence ?? 0;
    const followed = this.follow(agent.id, last?.sequence ?? 0);
    try {
      await followed.connected;
      if (this.stopped) return this.endStopped();
      await this.submit(agent.id, work);
      this.submitted = true;
      void this.check();
      await followed.done;
    } finally {
      // However the run ends, nothing streams after it.
      this.following.abort();
      await followed.done.catch(() => undefined);
    }

    if (this.stopped) return this.endStopped();
    if (this.failure) throw this.failure;
    // The client left: nothing more is sent, and the agent carries on in Omnara.
    if (this.detached) return { outcome: { type: "success" } };
    if (!this.settled)
      throw new Error("event stream ended before the agent settled");
    return { outcome: this.settled };
  }

  // ---------------------------------------------------------------- agent

  private async findOrCreateAgent(): Promise<Agent> {
    const { api, config } = this.deps;
    if (!this.input.threadId.trim()) throw new Error("threadId is required");
    let launch: { config: string; profile?: string; name: string };
    // Omnara agent names: at most 64 characters, no edge or invisible spaces.
    const name = `AG-UI ${this.input.threadId.replace(/[^\w.:-]/g, "")}`
      .slice(0, 64)
      .trimEnd();
    if (config.profile) {
      const profile = await api.getProfile(config.profile);
      launch = { config: profile.current_config_id, profile: profile.id, name };
    } else {
      const def = config.definition!;
      const isText = typeof def.source === "string";
      const source = isText
        ? (def.source as string)
        : JSON.stringify(def.source);
      const created = await api.createConfig(
        source,
        def.format ?? (isText ? "yaml" : "json"),
      );
      launch = { config: created.id, name };
    }
    // A thread belongs to one agent per user: the launch key replays the agent
    // the thread started with, so a changed profile or definition only reaches
    // new threads.
    const user =
      config.user === "anonymous" ? { id: "anonymous" } : config.user;
    const key = createHash("sha256")
      .update(JSON.stringify([user.tenant ?? "", user.id, this.input.threadId]))
      .digest("hex");
    const { agent, created } = await api.launch(launch, `agui-thread:${key}`);
    this.agentId = agent.id;
    if (agent.state === "archived")
      throw new RunError(
        "thread_ended",
        new Error(`agent ${agent.id} is archived`),
      );
    if (created) {
      this.emit({
        type: EventType.CUSTOM,
        name: "omnara.agent",
        value: { agentId: agent.id, threadId: this.input.threadId },
      });
    }
    return agent;
  }

  private actor(): ExternalActorParams | undefined {
    const { user } = this.deps.config;
    if (user === "anonymous") return undefined;
    return {
      provider_user_id: user.id,
      ...(user.tenant ? { provider_tenant_id: user.tenant } : {}),
      ...(user.name ? { display_name: user.name } : {}),
    };
  }

  // ---------------------------------------------------------------- tools

  /**
   * Make the agent's custom tools match this request: the custom tools that
   * were not in its launch config are the adapter's, and get replaced by this
   * request's browser tools plus `backendTools`. Profiles are never written.
   */
  private async syncTools(agent: Agent, log: AgentEvent[]): Promise<void> {
    const { api, backendTools } = this.deps;
    const launchId = log.find(
      (e) => e.event_kind === "agent_input" && e.input_kind === "config_change",
    ) as { agent_config_id?: string } | undefined;
    const currentId = agent.current_config_id;
    if (!currentId) return;
    const current = parseSource(await api.getConfig(currentId));
    const launch =
      launchId?.agent_config_id && launchId.agent_config_id !== currentId
        ? parseSource(await api.getConfig(launchId.agent_config_id))
        : current;
    this.launchCustomTools = new Set(customToolNames(launch));

    // A tool the agent's own definition declares (built in, or custom with its
    // permission, say) is left as the definition has it.
    const declared = new Set(
      Object.keys((launch.tools as Record<string, unknown> | null) ?? {}),
    );
    const wanted: Record<string, unknown> = {};
    for (const t of [...(this.input.tools ?? []), ...backendTools.values()]) {
      if (!declared.has(t.name)) {
        wanted[t.name] = customTool(t.name, t.description, t.parameters);
      }
    }

    const tools = { ...((current.tools as Record<string, unknown>) ?? {}) };
    const owned: Record<string, unknown> = {};
    for (const name of customToolNames(current)) {
      if (!this.launchCustomTools.has(name)) {
        owned[name] = tools[name];
        delete tools[name];
      }
    }
    if (canonical(pickToolShape(owned)) === canonical(wanted)) return;

    const source = JSON.stringify({
      ...current,
      tools: { ...tools, ...wanted },
    });
    try {
      await api.setConfig(agent.id, source, "json", currentId);
    } catch (error) {
      // Omnara rejects an invalid or oversized config; other failures aren't the tools'.
      const status = statusOf(error);
      if (status === 400 || status === 413)
        throw new RunError("invalid_tools", error);
      throw error;
    }
  }

  private isBrowserCall(name: string, type: string): boolean {
    return (
      type === "custom" &&
      !this.launchCustomTools.has(name) &&
      !this.deps.backendTools.has(name)
    );
  }

  private noteToolCalls(event: AgentEvent): void {
    if (event.event_kind !== "model_output") return;
    for (const b of event.content_blocks) {
      if (b.type === "tool_call")
        this.toolNames.set(b.tool_call_id, { name: b.name, type: b.tool_type });
    }
  }

  // ---------------------------------------------------------------- submit

  private newWork(log: AgentEvent[]): Work {
    const known = new Set<string>();
    const answered = new Set<string>();
    for (const e of log) {
      if (e.event_kind === "agent_input") {
        known.add(e.agent_input_id);
        const id = clientIdOf(e);
        if (id !== undefined) known.add(id);
      } else if (e.event_kind === "tool_result") {
        answered.add(e.tool_call_id);
      }
    }
    const all = this.input.messages;
    return {
      // A message of the user's that the agent doesn't have yet.
      messages: all.filter(
        (m): m is UserMessage => m.role === "user" && !known.has(m.id),
      ),
      // The page answers only its own (browser) tools.
      results: all.filter((m): m is ToolMessage => {
        if (m.role !== "tool" || answered.has(m.toolCallId)) return false;
        const call = this.toolNames.get(m.toolCallId);
        return call !== undefined && this.isBrowserCall(call.name, call.type);
      }),
      resume: this.input.resume ?? [],
    };
  }

  /** Browser-tool results, then answers, then messages. A 409 means it's already there. */
  private async submit(agentId: string, work: Work): Promise<void> {
    const { api } = this.deps;
    const actor = this.actor();

    for (const result of work.results) {
      await this.postResult(
        agentId,
        result.toolCallId,
        result.error ? "failed" : "succeeded",
        messageText(result.content) || result.error || "",
      );
    }

    // If answering fails, the check after submitting sees the card still open
    // and ends with it again (CopilotKit hides a card when a run fails).
    const open = work.resume.length
      ? await api.openInteractions(agentId).then(
          (all) => new Map(all.map((i) => [i.id, i])),
          async (error) => {
            await this.report("resolve", error);
            return undefined;
          },
        )
      : undefined;
    if (open) {
      for (const entry of work.resume) {
        const interaction = open.get(entry.interruptId);
        if (!interaction) {
          // Answered or cancelled elsewhere, or not ours: proceed (the snapshot shows what happened).
          await this.report(
            "unknown_interrupt",
            new Error(`no open interaction ${entry.interruptId}`),
          );
          continue;
        }
        await accept409(() =>
          api.resolveInteraction(
            interaction.agent_id,
            interaction.id,
            answersFor(interaction, entry),
            actor,
          ),
        ).catch((error) => this.report("resolve", error));
      }
    }

    if (!work.messages.length) return;
    // A browser tool call the page never answered blocks the agent for good:
    // cancel that turn (Omnara's own cancel), then deliver the message.
    const answered = new Set(work.results.map((r) => r.toolCallId));
    const abandoned = (await api.readyCustomCalls(agentId)).filter(
      (c) =>
        c.agent_id === agentId &&
        this.isBrowserCall(c.name, c.type) &&
        !answered.has(c.id),
    );
    if (abandoned.length) await api.cancel(agentId, actor);

    const context = contextBlock(this.input.context);
    // A 409 means the message is already there, unless the agent was archived.
    const post = (blocks: CreateAgentInputContentBlock[], key: string) =>
      accept409(() =>
        api
          .postInput(agentId, { content_blocks: blocks, actor }, key)
          .catch((error) => {
            if (codeOf(error) === "state_transition_conflict") {
              throw new RunError("thread_ended", error);
            }
            throw error;
          }),
      );
    for (const message of work.messages) {
      const key = inputKey(message.id);
      const { blocks, media } = userBlocks(message, context);
      // Over Omnara's limit: the run says so rather than cut or replace it.
      if (contentBytes(blocks) > MAX_CONTENT_BYTES) {
        throw new RunError(
          "message_too_large",
          new Error(`message ${message.id} with its context is over 1 MiB`),
        );
      }
      try {
        await post(blocks, key);
      } catch (error) {
        const status = statusOf(error);
        if (
          !media ||
          error instanceof RunError ||
          status === undefined ||
          status < 400 ||
          status >= 500
        )
          throw error;
        // Omnara rejected an attachment: send the message without it.
        await this.report("attachment_rejected", error);
        await post(withoutMedia(blocks), key);
      }
    }
  }

  // ---------------------------------------------------------------- follow

  private follow(agentId: string, afterSequence: number) {
    let onConnected!: () => void;
    const connected = new Promise<void>((resolve) => (onConnected = resolve));
    const frames = this.deps.api.stream(
      agentId,
      afterSequence,
      this.following.signal,
      onConnected,
    );
    const done = (async () => {
      const timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
      try {
        for await (const frame of untilAborted(frames, this.following.signal)) {
          await this.onFrame(frame);
        }
      } finally {
        clearInterval(timer);
      }
    })();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("event stream did not connect")),
        CONNECT_TIMEOUT_MS,
      ).unref?.(),
    );
    return {
      connected: Promise.race([connected, done, timeout]).then(() => undefined),
      done,
    };
  }

  private async onFrame(frame: AgentEventStreamFrame): Promise<void> {
    if ("event_kind" in frame) return this.onEvent(frame as AgentEvent);
    if ("model_call_context_id" in frame && "event" in frame)
      return this.onDelta(frame);
    if ("tool_call_id" in frame && "state" in frame) {
      if (frame.state === "ready" || frame.state === "awaiting_permission")
        void this.check();
    }
  }

  private async onEvent(event: AgentEvent): Promise<void> {
    this.noteToolCalls(event);
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
    this.turnEnded = turnOver(event, this.turnEnded);
    if (event.event_kind === "agent_input") {
      if (event.input_kind === "content") {
        this.cancelled = false;
        const key = event.input_idempotency_key;
        if (key && this.pendingKeys.delete(key) && this.pendingKeys.size === 0)
          void this.check();
        if (clientIdOf(event) === undefined) await this.emitOtherInput(event);
      } else if (event.input_kind === "control") {
        this.cancelled = true;
        void this.check();
      }
    } else if (event.event_kind === "model_output") {
      this.emitModelOutput(event);
      this.modelError =
        event.stop_reason === "error"
          ? event.content_blocks
              .map((b) => (b.type === "error" ? b.text : ""))
              .join("\n")
          : undefined;
      this.cancelled = false;
      if (this.turnEnded) void this.check();
    } else if (event.event_kind === "tool_result") {
      const call = this.toolNames.get(event.tool_call_id);
      // Browser-tool results are the client's own; the producer must not answer them.
      if (!call || !this.isBrowserCall(call.name, call.type)) {
        this.closeOpen();
        this.emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: event.id,
          toolCallId: event.tool_call_id,
          content: toolResultText(event.content_blocks),
          role: "tool",
        });
      }
    }
  }

  /** Finished, or waiting on the user, the page or a host-run tool? Ends the follow when settled. */
  private async check(): Promise<void> {
    if (this.settled || !this.submitted) return;
    if (this.following.signal.aborted) return;
    if (this.checking) {
      // Something happened mid-check: look again once this one is done.
      this.checkAgain = true;
      return;
    }
    this.checking = true;
    const seen = this.lastSequence;
    try {
      const agentId = this.agentId!;
      const waiting = await this.waitingOutcome(agentId, true);
      if (waiting === null) return; // ran host tools; keep following
      let outcome = waiting;
      if (!outcome && this.pendingKeys.size && this.turnEnded)
        await this.dropCancelledInputs(agentId);
      // Finished only once our messages have started (a queued message runs
      // after whatever is ahead of it) and nothing is still on its way.
      if (
        !outcome &&
        this.pendingKeys.size === 0 &&
        this.turnEnded &&
        !(await this.subagentsBusy(agentId))
      ) {
        outcome = { type: this.cancelled ? "cancelled" : "success" };
      }
      if (outcome && !this.following.signal.aborted) {
        // An event arrived while checking (a subagent's report, say): what was
        // read may be stale, so look again instead of settling.
        if (this.lastSequence !== seen) {
          this.checkAgain = true;
          return;
        }
        this.settled = outcome;
        this.following.abort();
      }
    } catch (error) {
      await this.report("check", error);
    } finally {
      this.checking = false;
      if (this.checkAgain) {
        this.checkAgain = false;
        void this.check();
      }
    }
  }

  /**
   * The outcome for what the agent waits on: an approval or question, or a
   * browser tool. With `runHostTools`, ready `backendTools` calls are run, a
   * subagent's call to a page tool gets a failed result, and `null` is
   * returned (the agent will continue).
   */
  private async waitingOutcome(
    agentId: string,
    runHostTools = false,
  ): Promise<RunFinishedOutcome | undefined | null> {
    const { api, backendTools } = this.deps;
    const interactions = await api.openInteractions(agentId);
    if (interactions.length) {
      return { type: "interrupt", interrupts: interactions.map(toInterrupt) };
    }
    const ready = await api.readyCustomCalls(agentId);
    const hostCalls = ready.filter(
      (c) => backendTools.has(c.name) && !this.handledCalls.has(c.id),
    );
    // `type: self` subagents inherit the page's tools but can't reach the page.
    // Other custom tools on subagents (a profile's own) are left to their workers.
    const pageTools = new Set((this.input.tools ?? []).map((t) => t.name));
    const subagentBrowserCalls = ready.filter(
      (c) =>
        c.agent_id !== agentId &&
        pageTools.has(c.name) &&
        this.isBrowserCall(c.name, c.type) &&
        !this.handledCalls.has(c.id),
    );
    if (runHostTools && (hostCalls.length || subagentBrowserCalls.length)) {
      await Promise.all([
        ...hostCalls.map((c) => this.runBackendTool(c)),
        ...subagentBrowserCalls.map((c) =>
          this.deliver(c, "failed", SUBAGENT_BROWSER_TOOL),
        ),
      ]);
      return null;
    }
    const pending = ready.filter(
      (c) => c.agent_id === agentId && this.isBrowserCall(c.name, c.type),
    );
    if (pending.length)
      return { type: "success", pendingToolCallIds: pending.map((c) => c.id) };
    return undefined;
  }

  /**
   * Whether subagents are still working for this conversation. Omnara stores a
   * subagent's report in the parent's backlog in the same transaction as its
   * final output, then moves it into the log; reading in this order (running
   * subagents, then the backlog, then the log) can't miss a report in transit.
   * A stopped subagent sends no report and is simply not running.
   */
  private async subagentsBusy(agentId: string): Promise<boolean> {
    if (![...this.toolNames.values()].some((t) => t.name === "spawn_agent")) {
      return false;
    }
    const { api } = this.deps;
    const children = await api.listChildren(agentId);
    const working = (c: (typeof children)[number]) =>
      c.state !== "archived" &&
      (c.activity?.state === "running" ||
        c.activity?.state === "waiting_on_interaction");
    if (children.some(working)) return true;
    if ((await api.listBacklog(agentId)).length) return true;
    return api.hasEventsAfter(agentId, this.lastSequence);
  }

  /** A message of ours that's neither queued nor in the log was cancelled (from Omnara's dashboard, say). */
  private async dropCancelledInputs(agentId: string): Promise<void> {
    const { api } = this.deps;
    // Leaving the queue and entering the log are one step: read the queue first.
    const queued = new Set(
      (await api.listBacklog(agentId)).map((i) => i.input_idempotency_key),
    );
    if (await api.hasEventsAfter(agentId, this.lastSequence)) return;
    for (const key of this.pendingKeys) {
      if (!queued.has(key)) this.pendingKeys.delete(key);
    }
  }

  private async runBackendTool(call: ToolCall): Promise<void> {
    this.handledCalls.add(call.id);
    const tool = this.deps.backendTools.get(call.name)!;
    let outcome: "succeeded" | "failed" = "succeeded";
    let text: string;
    try {
      const value = await tool.handler(call.input, { toolCallId: call.id });
      text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    } catch (error) {
      // The handler's own message: the host's code, and what the agent needs to recover.
      outcome = "failed";
      text = error instanceof Error ? error.message : String(error);
    }
    await this.deliver(call, outcome, text);
  }

  /** Post a result for a call this run answers. If Omnara doesn't take it, the run fails. */
  private async deliver(
    call: ToolCall,
    outcome: "succeeded" | "failed",
    text: string,
  ): Promise<void> {
    this.handledCalls.add(call.id);
    try {
      await this.postResult(call.agent_id, call.id, outcome, text);
    } catch (error) {
      this.failure = error;
      this.following.abort();
    }
  }

  /** A tool result over Omnara's size limit goes as a failed result saying so. A 409 means it's already there. */
  private async postResult(
    agentId: string,
    toolCallId: string,
    outcome: "succeeded" | "failed",
    text: string,
  ): Promise<void> {
    let block = { type: "text" as const, text };
    if (contentBytes([block]) > MAX_CONTENT_BYTES) {
      await this.report(
        "result_too_large",
        new Error(`result for ${toolCallId} is over 1 MiB`),
      );
      outcome = "failed";
      block = { type: "text", text: RESULT_TOO_LARGE };
    }
    await accept409(() =>
      this.deps.api.submitResult(agentId, toolCallId, outcome, [block]),
    );
  }

  /** Stop: cancel the agent's work (once it's known) and end as cancelled. */
  private async endStopped(): Promise<Ending> {
    if (this.agentId) await this.cancelWork(this.agentId);
    return { outcome: { type: "cancelled" } };
  }

  /** Cancel the agent's running subagents, nested ones first, then the agent (Omnara's default cancel). */
  private async cancelWork(agentId: string): Promise<void> {
    await this.cancelSubagents(agentId);
    await this.deps.api
      .cancel(agentId, this.actor())
      .catch((e) => this.report("cancel", e));
  }

  /** Omnara's cancel doesn't reach subagents, and an idle one can have working subagents of its own. */
  private async cancelSubagents(agentId: string): Promise<void> {
    const { api } = this.deps;
    // No `spawn_agent` check (unlike `subagentsBusy`): Stop can land before the log is read.
    const children = await api.listChildren(agentId).catch(async (e) => {
      await this.report("cancel_subagent", e);
      return [];
    });
    for (const child of children) {
      if (child.state === "archived") continue;
      await this.cancelSubagents(child.id);
      if (child.activity?.state !== "idle") {
        await api
          .cancel(child.id, this.actor())
          .catch((e) => this.report("cancel_subagent", e));
      }
    }
  }

  // ---------------------------------------------------------------- emit

  private emit(event: AGUIEvent): void {
    if (!this.detached) this.emitEvent(event);
  }

  private closeOpen(): void {
    if (this.openText) {
      this.emit({ type: EventType.TEXT_MESSAGE_END, messageId: this.openText });
      this.openText = undefined;
    }
    if (this.openReasoning) {
      this.emit({
        type: EventType.REASONING_MESSAGE_END,
        messageId: this.openReasoning,
      });
      this.emit({
        type: EventType.REASONING_END,
        messageId: this.openReasoning,
      });
      this.openReasoning = undefined;
    }
  }

  private openTextMessage(id: string): void {
    if (this.openText === id) return;
    this.closeOpen();
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: id,
      role: "assistant",
    });
    this.openText = id;
  }

  private openReasoningMessage(id: string): void {
    if (this.openReasoning === id) return;
    this.closeOpen();
    this.emit({ type: EventType.REASONING_START, messageId: id });
    this.emit({
      type: EventType.REASONING_MESSAGE_START,
      messageId: id,
      role: "reasoning",
    });
    this.openReasoning = id;
  }

  /** Live previews. Only a model call seen from its first delta is previewed; a gap stops it. */
  private onDelta(
    frame: Extract<
      AgentEventStreamFrame,
      { model_call_context_id: string; event: unknown }
    >,
  ): void {
    const mcc = frame.model_call_context_id;
    let preview = this.previews.get(mcc);
    if (!preview) {
      preview = {
        text: "",
        reasoning: new Set(),
        next: 1,
        broken: frame.seq !== 1,
      };
      this.previews.set(mcc, preview);
    }
    if (preview.broken) return;
    if (frame.seq !== preview.next) {
      preview.broken = true;
      this.closeOpen();
      return;
    }
    preview.next = frame.seq + 1;
    const delta = frame.event;
    switch (delta.kind) {
      case "block_start":
        if (delta.block.kind === "text") this.openTextMessage(mcc);
        break;
      case "text_delta":
        if (this.openText === mcc && delta.delta) {
          preview.text += delta.delta;
          this.emit({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: mcc,
            delta: delta.delta,
          });
        }
        break;
      case "thinking_delta": {
        if (!delta.delta) break;
        const id = reasoningId(mcc, delta.block_index);
        // Opened on its first text: OpenAI reasoning streams blocks with none.
        if (!preview.reasoning.has(delta.block_index)) {
          preview.reasoning.add(delta.block_index);
          this.openReasoningMessage(id);
        }
        if (this.openReasoning === id) {
          this.emit({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: id,
            delta: delta.delta,
          });
        }
        break;
      }
      case "block_stop":
        if (
          this.openText === mcc ||
          this.openReasoning === reasoningId(mcc, delta.block_index)
        ) {
          this.closeOpen();
        }
        break;
      case "error":
        preview.broken = true;
        this.closeOpen();
        break;
    }
  }

  /** The recorded output completes what was previewed; tool calls come only from here. */
  private emitModelOutput(
    event: Extract<AgentEvent, { event_kind: "model_output" }>,
  ): void {
    const mcc = event.model_call_context_id;
    const preview = this.previews.get(mcc);
    this.closeOpen();
    event.content_blocks.forEach((b, i) => {
      if (b.type !== "reasoning" || !b.text || preview?.reasoning.has(i))
        return;
      const id = reasoningId(mcc, i);
      this.openReasoningMessage(id);
      this.emit({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: id,
        delta: b.text,
      });
      this.closeOpen();
    });
    const text = visibleText(event.content_blocks);
    const shown = preview?.text ?? "";
    if (text.length > shown.length && text.startsWith(shown)) {
      this.openTextMessage(mcc);
      this.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: mcc,
        delta: text.slice(shown.length),
      });
      this.closeOpen();
    }
    for (const b of event.content_blocks) {
      if (b.type !== "tool_call") continue;
      this.emit({
        type: EventType.TOOL_CALL_START,
        toolCallId: b.tool_call_id,
        toolCallName: b.name,
        parentMessageId: mcc,
      });
      this.emit({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: b.tool_call_id,
        delta: JSON.stringify(b.input ?? {}),
      });
      this.emit({ type: EventType.TOOL_CALL_END, toolCallId: b.tool_call_id });
    }
  }

  /** A message from someone else (a subagent report, a dashboard or API user), in place. */
  private async emitOtherInput(
    event: Extract<AgentEvent, { event_kind: "agent_input" }>,
  ): Promise<void> {
    const text = inputText(event.content_blocks);
    if (!text) return;
    const author = event.actor_id
      ? await this.author(event.actor_id)
      : { role: "user" as const };
    this.closeOpen();
    this.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: event.agent_input_id,
      role: author.role,
      ...(author.name ? { name: author.name } : {}),
    });
    this.emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: event.agent_input_id,
      delta: text,
    });
    this.emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: event.agent_input_id,
    });
  }

  /**
   * A subagent is an Omnara actor whose user id is an agent id; people in
   * Omnara's dashboard, API keys and schedules are Omnara actors too.
   */
  private author(actorId: string): Promise<Author> {
    let found = this.authors.get(actorId);
    if (!found) {
      found = this.deps.api.getActor(actorId).then(
        (a): Author =>
          a.provider === "omnara" && a.provider_user_id.startsWith("agt_")
            ? { role: "assistant", name: a.display_name || "Subagent" }
            : {
                role: "user",
                ...(a.display_name ? { name: a.display_name } : {}),
              },
        async (error) => {
          await this.report("actor", error);
          return { role: "user" as const };
        },
      );
      this.authors.set(actorId, found);
    }
    return found;
  }

  /** The chat's history from Omnara's log, keeping `clientMessages` (see `snapshotMessages`). */
  private async history(
    events: AgentEvent[],
    clientMessages: Message[],
  ): Promise<Message[]> {
    const authors = new Map<string, Author>();
    for (const e of events) {
      if (
        e.event_kind === "agent_input" &&
        e.input_kind === "content" &&
        e.actor_id &&
        clientIdOf(e) === undefined
      ) {
        authors.set(e.actor_id, await this.author(e.actor_id));
      }
    }
    return snapshotMessages(events, {
      clientMessages,
      isBrowserCall: (name, type) => this.isBrowserCall(name, type),
      authors,
    });
  }

  /**
   * Put what the chat missed while idle (someone else's message, the agent's
   * reply to it) above this request's new messages, where it happened. The
   * client keeps the messages it holds in place and adds new ones at the end,
   * so the history goes out without the new messages, then with them.
   */
  private async restoreOrder(
    log: AgentEvent[],
    fresh: UserMessage[],
  ): Promise<void> {
    const held = new Set(this.input.messages.map((m) => m.id));
    const freshIds = new Set(fresh.map((m) => m.id));
    const history = await this.history(
      log,
      this.input.messages.filter((m) => !freshIds.has(m.id)),
    );
    // Nothing to place it after (a server restart), or nothing missed.
    // Reasoning doesn't count: not every client sends it back.
    if (!history[0] || !held.has(history[0].id)) return;
    if (history.every((m) => m.role === "reasoning" || held.has(m.id))) return;
    this.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: history });
    if (fresh.length) {
      this.emit({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [...history, ...fresh],
      });
    }
  }

  private async sendSnapshot(): Promise<void> {
    if (!this.agentId) return;
    try {
      const events = await this.deps.api.listEvents(this.agentId);
      for (const e of events) this.noteToolCalls(e);
      const messages = await this.history(events, this.input.messages);
      this.emit({ type: EventType.MESSAGES_SNAPSHOT, messages });
    } catch (error) {
      await this.report("snapshot", error);
    }
  }

  private report(operation: string, error: unknown): Promise<void> {
    return this.deps.report(error, {
      operation,
      threadId: this.input.threadId,
      agentId: this.agentId,
    });
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Stop iterating as soon as `signal` aborts. `@omnara/sdk`'s stream can miss
 * an abort after a garbage collection and keep reading until its next
 * heartbeat (up to 10s); this keeps a settled run from waiting on it.
 */
async function* untilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    if (signal.aborted) resolve({ done: true, value: undefined });
    signal.addEventListener(
      "abort",
      () => resolve({ done: true, value: undefined }),
      { once: true },
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.()?.catch(() => undefined);
  }
}

/**
 * Whether the agent's turn is over after `event`, given whether it was before:
 * a message starts one; a final output or a cancel ends it; a tool result
 * continues it. Anything else (a config change, say) changes nothing.
 */
function turnOver(event: AgentEvent, over: boolean): boolean {
  switch (event.event_kind) {
    case "agent_input":
      if (event.input_kind === "content") return false;
      return event.input_kind === "control" ? true : over;
    case "model_output":
      return (
        event.stop_reason !== "max_tokens" &&
        !event.content_blocks.some((b) => b.type === "tool_call")
      );
    case "tool_result":
      return event.outcome === "canceled" ? over : false;
    default:
      return over;
  }
}

async function accept409(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    if (statusOf(error) !== 409) throw error;
  }
}

function inputKey(messageId: string): string {
  const key = `${INPUT_KEY_PREFIX}${messageId}`;
  return key.length <= 255
    ? key
    : `${INPUT_KEY_PREFIX}${createHash("sha256").update(messageId).digest("hex")}`;
}
