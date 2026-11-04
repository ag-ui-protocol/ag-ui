import { randomUUID } from "node:crypto";
import {
  EventType,
  type BaseEvent,
  type Interrupt,
  type ResumeEntry,
  type RunAgentInput,
  type State,
  type UserMessage,
} from "@ag-ui/core";
import type OpenAI from "openai";
import {
  contextPart,
  splitFirstContact,
  toInputParts,
  toToolOutput,
  toolResultsById,
  transcriptPart,
  undeliveredUserMessages,
} from "./input";
import { RunQueue } from "./queue";
import { forget, newSessionRecord, remember } from "./sessions";
import { fingerprintTools, mergeTools, parseArguments } from "./tools";
import { EventTranslator, type SurfacedFunctionCall } from "./translate";
import type {
  AgentSession,
  AgentToolParam,
  ApprovalRequestAction,
  BackendTool,
  BackendToolContext,
  FunctionCallAction,
  InputContentPart,
  InterruptRequest,
  OpenAIAgentsAgentConfig,
  OpenInterrupt,
  RequiredAction,
  SessionEvent,
  SessionInputEvent,
  SessionRecord,
  SessionStore,
} from "./types";

/** Thrown by `context.interrupt()`; caught by the adapter, never by user code. */
export class InterruptSignal extends Error {
  constructor(readonly request: InterruptRequest) {
    super("Backend tool interrupted the run");
    this.name = "InterruptSignal";
  }
}

/** A failure with a stable code for RUN_ERROR. */
export class RunFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RunFailure";
  }
}

export const TOOL_APPROVAL_REASON = "tool_approval";
export const TOOL_INTERRUPT_REASON = "openai_agents:tool_interrupt";
export const COMPUTER_USE_APPROVAL_REASON =
  "openai_agents:computer_use_approval";

/** Without any session event for this long, the run re-reads the session. */
const WATCHDOG_MS = 15_000;
/** How long to wait for a cancelled turn to stop before sending new input. */
const CANCEL_GRACE_MS = 15_000;
const MAX_RECONNECTS = 5;

export interface RunDependencies {
  client: OpenAI;
  config: OpenAIAgentsAgentConfig;
  store: SessionStore;
  storeKey: string;
  backendTools: Map<string, BackendTool>;
  /** Tools of the saved agent (`savedAgentId`), used when `agent.tools` is not set. */
  savedAgentTools: () => Promise<AgentToolParam[] | undefined>;
  reportError: (error: unknown, context: string) => void;
}

type ToolResultEvent = Extract<
  SessionInputEvent,
  { type: "agent.session.input.tool_result" }
>;

interface Job {
  action: FunctionCallAction;
  resume?: ResumeEntry;
  /** Answering an approval interrupt rather than a handler's own interrupt. */
  approval?: boolean;
}

const isApproved = (resume: ResumeEntry): boolean => {
  if (resume.status !== "resolved") return false;
  const payload = resume.payload as unknown;
  if (payload === false) return false;
  if (payload && typeof payload === "object") {
    const answer = payload as Record<string, unknown>;
    if (
      answer.approved === false ||
      answer.rejected === true ||
      answer.cancelled === true
    )
      return false;
  }
  return true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One AG-UI run against an OpenAI Agents API session.
 *
 * The run sends the client's new input (user messages, frontend tool results,
 * interrupt answers) to the thread's session, then follows the session's event
 * stream until the turn completes, fails, or parks on work only the client can
 * do (a frontend tool call or an interrupt).
 */
export class Run {
  private record: SessionRecord = newSessionRecord("");
  private state: State;
  private finished = false;
  private readonly queue = new RunQueue<SessionEvent>();
  private readonly translator: EventTranslator;
  private streamSource = 0;
  private streamAbort: AbortController | undefined;
  private reconnects = 0;

  private sessionStatus: AgentSession["status"] | undefined;
  private requiredActions: RequiredAction[] = [];
  private readonly jobsStarted = new Set<string>();
  private inflight = 0;
  /** Interrupts this run will end on, by id. */
  private readonly raised = new Map<string, Interrupt>();
  private settleAt: number | undefined;
  /** Input was sent (or a live turn joined): the session going idle ends the run. */
  private progressing = false;
  /** A backend tool result that could not be delivered. Fails the run. */
  private jobFailure: unknown;
  /** The root turn completed; the run ends once in-flight backend tools settle. */
  private turnCompleted = false;
  /** Aborted when the run ends for any reason: stops backend tools and their submits. */
  private readonly runAbort = new AbortController();
  /** A session create was sent and its id is not known yet. */
  private creating = false;

  constructor(
    private readonly deps: RunDependencies,
    private readonly input: RunAgentInput,
    private readonly emitEvent: (event: BaseEvent) => void,
    private readonly signal: AbortSignal,
  ) {
    this.state = structuredClone(input.state ?? {});
    if (signal.aborted) this.runAbort.abort();
    else
      signal.addEventListener(
        "abort",
        () => {
          this.runAbort.abort();
          // The loop may be waiting on a stream that does not follow the abort.
          this.queue.wake();
        },
        { once: true },
      );
    this.translator = new EventTranslator({
      emit: (event) => this.emit(event),
      isSurfaced: (itemId) => this.record.surfacedItemIds.includes(itemId),
      markSurfaced: (itemId) => remember(this.record.surfacedItemIds, itemId),
      onFunctionCall: (call) => this.onFunctionCall(call),
      predictState: deps.config.predictState,
      extractLinkCitations: deps.config.extractLinkCitations,
      onPredictedState: (update) => {
        this.state = { ...(this.state as Record<string, unknown>), ...update };
        this.emit({
          type: EventType.STATE_SNAPSHOT,
          snapshot: this.state,
        } as BaseEvent);
      },
    });
  }

  private get config() {
    return this.deps.config;
  }

  private get client() {
    return this.deps.client;
  }

  private get sessionId(): string {
    return this.record.sessionId;
  }

  private emit(event: BaseEvent): void {
    if (this.finished || this.signal.aborted) return;
    this.emitEvent(event);
  }

  async execute(): Promise<void> {
    this.emit({
      type: EventType.RUN_STARTED,
      threadId: this.input.threadId,
      runId: this.input.runId,
    } as BaseEvent);
    try {
      await this.drive();
      if (!this.finished && !this.signal.aborted) this.finish();
    } catch (error) {
      if (!this.signal.aborted) this.fail(error);
    } finally {
      const abandoned = this.signal.aborted && !this.finished;
      // Stopped while the session was being created: learn its id so the
      // turn can be cancelled and the thread keeps its session.
      if (abandoned) await this.awaitCreatedSession();
      this.closeStream();
      if (abandoned) await this.cancelTurn();
      // Backend tools still running when the run failed may still deliver
      // their results (bounded), so a retry does not run them again. Then the
      // rest are stopped; their results are no longer submitted.
      if (!abandoned) await this.settleJobs(5_000);
      this.runAbort.abort();
      await this.settleJobs(1_000);
      await this.persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Starting or continuing the session

  private async drive(): Promise<void> {
    const stored = await this.deps.store.get(this.deps.storeKey);
    let session: AgentSession | undefined;
    if (stored) {
      session = await this.retrieveSession(stored.sessionId);
      if (session?.status === "failed") session = undefined;
    }
    const tools = await this.resolveTools();
    if (!stored || !session) {
      await this.startSession(tools);
      return;
    }
    this.record = { ...newSessionRecord(stored.sessionId), ...stored };
    await this.continueSession(session, tools);
  }

  private async retrieveSession(
    sessionId: string,
  ): Promise<AgentSession | undefined> {
    try {
      return await this.client.beta.agents.sessions.retrieve(sessionId, {
        signal: this.signal,
      });
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
  }

  private async resolveTools(): Promise<AgentToolParam[]> {
    const configured =
      this.config.agent?.tools ??
      (this.config.savedAgentId
        ? await this.deps.savedAgentTools()
        : undefined);
    return mergeTools(
      configured ?? undefined,
      [...this.deps.backendTools.values()],
      this.input.tools ?? [],
    );
  }

  private contextPart(): InputContentPart | undefined {
    return contextPart(
      this.input.context ?? [],
      this.config.forwardState === false ? undefined : this.input.state,
    );
  }

  private async startSession(tools: AgentToolParam[]): Promise<void> {
    const { history, pending } = splitFirstContact(this.input.messages);
    const userParts = pending.flatMap((message) =>
      toInputParts(message.content),
    );
    const transcript = transcriptPart(history);
    if (!userParts.length && !transcript) return; // Nothing to send: an empty run.

    const content = [
      transcript,
      this.contextPart(),
      ...(userParts.length
        ? userParts
        : [
            { type: "input_text" as const, text: "Continue the conversation." },
          ]),
    ].filter((part): part is InputContentPart => part !== undefined);

    this.record = newSessionRecord("");
    this.record.toolsFingerprint = fingerprintTools(tools);
    for (const message of this.input.messages) {
      if (message.role === "user")
        remember(this.record.deliveredMessageIds, message.id);
    }

    const metadata = {
      ...this.config.sessionMetadata,
      ag_ui_thread_id: this.input.threadId.slice(0, 512),
    };
    // Not tied to the client's abort: a stop during creation still needs the
    // session id, which only the stream's first event carries.
    const controller = this.newStreamController(false);
    this.creating = true;
    const stream = await this.client.beta.agents.sessions.create(
      {
        ...(this.config.savedAgentId
          ? { agent_id: this.config.savedAgentId }
          : {}),
        agent: { ...this.config.agent, tools },
        environment: this.config.environment ?? { type: "none" },
        input: [{ role: "user", content }],
        metadata,
        ...(this.config.vaultIds ? { vault_ids: this.config.vaultIds } : {}),
        stream: true,
      },
      { signal: controller.signal },
    );
    this.progressing = true;
    void this.queue.pump(
      stream as AsyncIterable<SessionEvent>,
      this.streamSource,
    );
    await this.loop();
  }

  private async continueSession(
    initial: AgentSession,
    tools: AgentToolParam[],
  ): Promise<void> {
    let session = initial;
    const fingerprint = fingerprintTools(tools);
    if (fingerprint !== this.record.toolsFingerprint) {
      session = await this.client.beta.agents.sessions.update(
        this.sessionId,
        { agent: { tools } },
        { signal: this.signal },
      );
      this.record.toolsFingerprint = fingerprint;
    }
    session = await this.waitForCancel(session);

    const results = toolResultsById(this.input.messages);
    const newMessages = undeliveredUserMessages(
      this.input.messages,
      this.record.deliveredMessageIds,
    );
    const resumes = new Map(
      (this.input.resume ?? []).map((entry) => [entry.interruptId, entry]),
    );
    const movedOn = newMessages.length > 0;
    const events: SessionInputEvent[] = [];
    const jobs: Job[] = [];
    const actions =
      session.status === "requires_action" ? session.required_actions : [];

    for (const action of actions) {
      if (action.type === "function_call") {
        if (this.record.answeredCallIds.includes(action.call_id)) continue;
        const open = this.record.openInterrupts[action.call_id];
        if (open) {
          const resume = resumes.get(action.call_id);
          // The interrupt stays recorded until its result is submitted, so a
          // failed resume can be retried with the same answer.
          if (resume) {
            jobs.push({ action, resume, approval: open.kind === "approval" });
          } else if (movedOn) {
            events.push(
              this.toolResult(action, {
                error:
                  "The user did not answer and continued the conversation instead.",
              }),
            );
          } else {
            this.raised.set(action.call_id, open.interrupt);
          }
          continue;
        }
        if (this.deps.backendTools.has(action.name)) {
          // A backend call nobody ran to completion (e.g. the server restarted).
          jobs.push({ action });
          continue;
        }
        const result = results.get(action.call_id);
        if (result) {
          events.push(
            result.error
              ? this.toolResult(action, { error: result.error })
              : this.toolResult(action, { output: toToolOutput(result) }),
          );
          continue;
        }
        if (this.record.clientToolCallIds.includes(action.call_id)) {
          // Handed to the client earlier and never answered: a display-only
          // tool, or the user moved on. Release the session either way.
          events.push(
            this.toolResult(action, {
              output:
                "The application returned no result for this tool call; the conversation continued.",
            }),
          );
        }
        // Otherwise the client has not seen this call yet; the stream replay surfaces it.
      } else if (action.type === "computer_use_approval_request") {
        const resume = resumes.get(action.request_id);
        if (resume || movedOn) {
          events.push(this.approvalResult(action, resume));
        } else {
          this.raiseApprovalRequest(action);
        }
      }
    }

    if (newMessages.length) {
      const content = [
        this.contextPart(),
        ...newMessages.flatMap((message: UserMessage) =>
          toInputParts(message.content),
        ),
      ].filter((part): part is InputContentPart => part !== undefined);
      if (content.length)
        events.push({
          type: "agent.session.input.message",
          input: [{ role: "user", content }],
        });
    }

    if (!events.length && !jobs.length && session.status === "idle") return; // Nothing to do.

    this.sessionStatus = session.status;
    this.requiredActions = actions;
    // Following a live turn: its end ends this run too.
    if (session.status === "in_progress") this.progressing = true;

    await this.connect();
    if (jobs.length) this.progressing = true;
    for (const job of jobs) this.startJob(job);
    if (events.length) {
      await this.submit(events);
      this.progressing = true;
      // Recorded only once the session has the messages, so a failed submit
      // sends them again on retry.
      for (const message of newMessages)
        remember(this.record.deliveredMessageIds, message.id);
      // A message to an idle session starts a turn; until its events arrive,
      // treat it as running so a stop cancels it.
      if (newMessages.length && this.sessionStatus === "idle")
        this.sessionStatus = "in_progress";
    }
    if (session.status === "requires_action") this.onRequiresAction(actions);
    await this.loop();
  }

  /** A cancel sent by an earlier run may still be landing; give it time before sending input. */
  private async waitForCancel(session: AgentSession): Promise<AgentSession> {
    const requestedAt = this.record.cancelRequestedAt;
    if (requestedAt === undefined) return session;
    let current = session;
    while (
      current.status === "in_progress" &&
      Date.now() - requestedAt < CANCEL_GRACE_MS
    ) {
      await sleep(500);
      if (this.signal.aborted) return current;
      current = await this.client.beta.agents.sessions.retrieve(
        this.sessionId,
        { signal: this.signal },
      );
    }
    if (current.status !== "in_progress") delete this.record.cancelRequestedAt;
    return current;
  }

  // ---------------------------------------------------------------------------
  // Following the session

  private newStreamController(followClientAbort = true): AbortController {
    this.streamAbort?.abort();
    const controller = new AbortController();
    if (followClientAbort) {
      const onAbort = () => controller.abort();
      this.signal.addEventListener("abort", onAbort, { once: true });
      controller.signal.addEventListener(
        "abort",
        () => this.signal.removeEventListener("abort", onAbort),
        { once: true },
      );
    }
    this.streamAbort = controller;
    this.streamSource += 1;
    return controller;
  }

  private closeStream(): void {
    this.streamAbort?.abort();
    this.streamAbort = undefined;
  }

  /** Opens (or reopens) the session's event stream. Opening replays the active turn. */
  private async connect(): Promise<void> {
    const controller = this.newStreamController();
    const source = this.streamSource;
    const stream = await this.client.beta.agents.sessions.events.stream(
      this.sessionId,
      { signal: controller.signal },
    );
    void this.queue.pump(stream as AsyncIterable<SessionEvent>, source);
  }

  private async loop(): Promise<void> {
    const deadline = Date.now() + (this.config.runTimeoutMs ?? 10 * 60_000);
    let lastActivity = Date.now();
    while (!this.finished && !this.signal.aborted) {
      if (this.jobFailure !== undefined) throw this.jobFailure;
      const now = Date.now();
      if (now >= deadline) {
        await this.cancelTurn();
        throw new RunFailure(
          "The run exceeded its time limit and was cancelled.",
          "run_timeout",
        );
      }
      const waits = [deadline - now, WATCHDOG_MS - (now - lastActivity)];
      if (this.settleAt !== undefined) waits.push(this.settleAt - now);
      const item = await this.queue.next(Math.min(...waits));
      if (this.signal.aborted) {
        if (item.kind === "event") this.noteCreated(item.event);
        return;
      }

      if (item.kind === "event") {
        if (item.source !== this.streamSource) continue;
        lastActivity = Date.now();
        this.reconnects = 0;
        this.handleEvent(item.event);
        if (!this.finished) this.evaluateSettle();
        continue;
      }
      if (item.kind === "wake") {
        this.evaluateSettle();
        continue;
      }
      if (item.kind === "closed") {
        if (item.source !== this.streamSource) continue;
        lastActivity = Date.now();
        if (item.error && !this.isStreamDropError(item.error))
          this.deps.reportError(item.error, "session event stream");
        if (++this.reconnects > MAX_RECONNECTS) {
          throw new RunFailure(
            "Lost the connection to the agent session.",
            "stream_closed",
          );
        }
        await this.reconcile(true);
        continue;
      }
      // Timeout: the settle window elapsed, or nothing happened for a while.
      if (this.settleAt !== undefined && Date.now() >= this.settleAt) {
        this.finishWithClientWork();
        return;
      }
      if (Date.now() - lastActivity >= WATCHDOG_MS) {
        lastActivity = Date.now();
        await this.reconcile(false);
      }
    }
  }

  private noteCreated(event: SessionEvent): void {
    if (event.type !== "agent.session.created") return;
    this.record.sessionId = event.session.id;
    this.sessionStatus = event.session.status;
    this.creating = false;
  }

  /** After a stop during creation, waits briefly for the new session's id. */
  private async awaitCreatedSession(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (this.creating && !this.sessionId && Date.now() < deadline) {
      const item = await this.queue.next(deadline - Date.now());
      if (item.kind === "event") this.noteCreated(item.event);
      else if (item.kind !== "wake") return;
    }
  }

  /** Waits (bounded) for backend tools that are still running. */
  private async settleJobs(limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (this.inflight > 0 && Date.now() < deadline) await sleep(25);
  }

  private isStreamDropError(error: unknown): boolean {
    return (
      (error as { name?: string })?.name === "AbortError" || this.signal.aborted
    );
  }

  /** Brings the run in line with the session's actual state, after a dropped stream or a quiet spell. */
  private async reconcile(reconnect: boolean): Promise<void> {
    const session = await this.client.beta.agents.sessions.retrieve(
      this.sessionId,
      { signal: this.signal },
    );
    this.sessionStatus = session.status;
    switch (session.status) {
      case "failed":
        await this.forgetSession();
        throw new RunFailure(
          session.error ?? "The agent session failed.",
          "session_failed",
        );
      case "idle":
        if (this.inflight === 0) this.finish();
        return;
      case "requires_action":
        this.onRequiresAction(session.required_actions);
        break;
      default:
        break;
    }
    if (reconnect && !this.finished) await this.connect();
  }

  private handleEvent(event: SessionEvent): void {
    this.translator.handle(event);
    switch (event.type) {
      case "agent.session.created":
        this.noteCreated(event);
        void this.persist();
        return;
      case "agent.session.in_progress":
        this.sessionStatus = "in_progress";
        this.requiredActions = [];
        return;
      case "agent.session.requires_action":
        this.sessionStatus = "requires_action";
        this.onRequiresAction(event.session.required_actions);
        return;
      case "agent.session.turn.completed":
        if (!event.turn.subagent_id) {
          this.turnCompleted = true;
          this.finishIfDone();
        }
        return;
      case "agent.session.turn.cancelled":
        if (!event.turn.subagent_id) this.finish("cancelled");
        return;
      case "agent.session.turn.failed":
        if (!event.turn.subagent_id) {
          const error = event.turn.error;
          throw new RunFailure(
            error?.message ?? "The agent turn failed.",
            error?.code ?? "turn_failed",
          );
        }
        return;
      case "agent.session.idle":
        this.sessionStatus = "idle";
        this.finishIfDone();
        return;
      case "agent.session.failed":
        void this.forgetSession();
        throw new RunFailure(
          event.session.error ?? "The agent session failed.",
          "session_failed",
        );
      case "error":
        throw new RunFailure(
          event.error.message,
          event.error.code ?? "session_error",
        );
      default:
        return;
    }
  }

  private onRequiresAction(actions: RequiredAction[]): void {
    this.requiredActions = actions;
    for (const action of actions) {
      if (action.type === "function_call") {
        if (this.record.answeredCallIds.includes(action.call_id)) continue;
        this.translator.surfaceFunctionCall({
          callId: action.call_id,
          turnId: action.turn_id,
          name: action.name,
          arguments: action.arguments,
        });
        if (
          this.deps.backendTools.has(action.name) &&
          !this.jobsStarted.has(action.call_id) &&
          !this.record.openInterrupts[action.call_id]
        ) {
          this.startJob({ action });
        }
      } else if (action.type === "computer_use_approval_request") {
        this.raiseApprovalRequest(action);
      }
    }
    this.evaluateSettle();
  }

  private onFunctionCall(call: SurfacedFunctionCall): void {
    if (!this.deps.backendTools.has(call.name))
      remember(this.record.clientToolCallIds, call.callId);
  }

  /** Frontend tool calls the session is waiting on that the client has been given. */
  private pendingClientCalls(): string[] {
    return this.requiredActions
      .filter(
        (action): action is FunctionCallAction =>
          action.type === "function_call",
      )
      .filter(
        (action) =>
          !this.deps.backendTools.has(action.name) &&
          !this.record.answeredCallIds.includes(action.call_id) &&
          this.record.clientToolCallIds.includes(action.call_id),
      )
      .map((action) => action.call_id);
  }

  /**
   * Arms (or re-arms) the settle window when the session is parked on nothing
   * but client work. The Agents API reports parallel calls one at a time, so
   * the run waits for a quiet spell before handing them to the client.
   */
  private evaluateSettle(): void {
    if (this.finished) return;
    const clientWork = this.pendingClientCalls().length + this.raised.size;
    const parked =
      this.sessionStatus === "requires_action" || this.raised.size > 0;
    if (
      parked &&
      clientWork > 0 &&
      this.inflight === 0 &&
      !this.translator.streaming
    ) {
      this.settleAt = Date.now() + (this.config.clientToolSettleMs ?? 1000);
    } else {
      this.settleAt = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Backend tools and interrupts

  private startJob(job: Job): void {
    // The call must reach the client before its TOOL_CALL_RESULT.
    this.translator.surfaceFunctionCall({
      callId: job.action.call_id,
      turnId: job.action.turn_id,
      name: job.action.name,
      arguments: job.action.arguments,
    });
    this.jobsStarted.add(job.action.call_id);
    this.inflight += 1;
    this.settleAt = undefined;
    void this.runJob(job)
      .catch((error) => {
        // A result that cannot be delivered leaves the session parked: fail the run.
        if (!this.signal.aborted && this.jobFailure === undefined)
          this.jobFailure = error;
      })
      .finally(() => {
        this.inflight -= 1;
        this.finishIfDone();
        this.queue.wake();
      });
  }

  private async runJob({ action, resume, approval }: Job): Promise<void> {
    const tool = this.deps.backendTools.get(action.name)!;
    let args = parseArguments(action.arguments);
    let handlerResume = resume;

    if (approval && resume) {
      if (!isApproved(resume)) {
        const message =
          "The user rejected this tool call. It was not executed.";
        this.emitToolResult(
          action.call_id,
          JSON.stringify({ rejected: true, message }),
        );
        await this.submit([this.toolResult(action, { error: message })]);
        return;
      }
      const edited = (resume.payload as { editedArgs?: unknown } | undefined)
        ?.editedArgs;
      if (edited && typeof edited === "object")
        args = edited as Record<string, unknown>;
      handlerResume = undefined;
    } else if (!resume && this.needsApproval(tool, args)) {
      this.raiseToolInterrupt(action, args, "approval", {
        reason: TOOL_APPROVAL_REASON,
        message: tool.approvalMessage?.(args) ?? `Allow ${tool.name} to run?`,
      });
      return;
    }

    try {
      const value = await tool.handler(
        args,
        this.toolContext(action, handlerResume),
      );
      const output =
        typeof value === "string" ? value : JSON.stringify(value ?? null);
      this.emitToolResult(action.call_id, output);
      await this.submit([this.toolResult(action, { output })]);
    } catch (error) {
      if (error instanceof InterruptSignal) {
        this.raiseToolInterrupt(action, args, "tool", error.request);
        return;
      }
      if (this.runAbort.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.emitToolResult(action.call_id, JSON.stringify({ error: message }));
      await this.submit([this.toolResult(action, { error: message })]);
    }
  }

  /** Ends the run once the turn is over and no backend tool is still running. */
  private finishIfDone(): void {
    if (this.inflight > 0 || this.finished) return;
    if (
      this.turnCompleted ||
      (this.progressing && this.sessionStatus === "idle")
    )
      this.finish();
  }

  private needsApproval(
    tool: BackendTool,
    args: Record<string, unknown>,
  ): boolean {
    const rule = tool.requiresApproval;
    return typeof rule === "function" ? rule(args) : rule === true;
  }

  private toolContext(
    action: FunctionCallAction,
    resume: ResumeEntry | undefined,
  ): BackendToolContext {
    const run = this;
    return {
      threadId: this.input.threadId,
      runId: this.input.runId,
      sessionId: this.sessionId,
      toolCallId: action.call_id,
      get state() {
        return run.state;
      },
      setState: (state: State) => {
        run.state = state;
        run.emit({
          type: EventType.STATE_SNAPSHOT,
          snapshot: state,
        } as BaseEvent);
      },
      emit: (event: BaseEvent) => run.emit(event),
      interrupt: (request?: InterruptRequest): never => {
        throw new InterruptSignal(request ?? {});
      },
      resume,
      signal: this.runAbort.signal,
    };
  }

  private raiseToolInterrupt(
    action: FunctionCallAction,
    args: Record<string, unknown>,
    kind: OpenInterrupt["kind"],
    request: InterruptRequest,
  ): void {
    const interrupt: Interrupt = {
      id: action.call_id,
      reason:
        request.reason ??
        (kind === "approval" ? TOOL_APPROVAL_REASON : TOOL_INTERRUPT_REASON),
      toolCallId: action.call_id,
      ...(request.message ? { message: request.message } : {}),
      ...(request.responseSchema
        ? { responseSchema: request.responseSchema }
        : {}),
      metadata: {
        toolName: action.name,
        arguments: args,
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
        ...request.metadata,
      },
    };
    this.record.openInterrupts[interrupt.id] = { kind, interrupt };
    this.raised.set(interrupt.id, interrupt);
  }

  private raiseApprovalRequest(action: ApprovalRequestAction): void {
    if (
      this.raised.has(action.request_id) ||
      this.record.answeredCallIds.includes(action.request_id)
    )
      return;
    const existing = this.record.openInterrupts[action.request_id];
    const interrupt: Interrupt = existing?.interrupt ?? {
      id: action.request_id,
      reason: COMPUTER_USE_APPROVAL_REASON,
      ...(action.request.reason ? { message: action.request.reason } : {}),
      metadata: { request: action.request },
    };
    this.record.openInterrupts[interrupt.id] = {
      kind: "computer_use",
      interrupt,
    };
    this.raised.set(interrupt.id, interrupt);
  }

  private approvalResult(
    action: ApprovalRequestAction,
    resume: ResumeEntry | undefined,
  ): SessionInputEvent {
    const kind = action.request.type;
    const answer =
      resume?.status === "resolved"
        ? (resume.payload as Record<string, unknown> | undefined)
        : undefined;
    const response =
      answer && typeof answer === "object"
        ? { type: kind, ...answer }
        : kind === "browser_authentication"
          ? { type: kind, action: "cancel" }
          : {
              type: kind,
              decision: resume?.status === "resolved" ? "approve" : "cancel",
            };
    return {
      type: "agent.session.input.computer_use_approval_request_result",
      request_id: action.request_id,
      response: response as never,
    };
  }

  // ---------------------------------------------------------------------------
  // Talking to the session

  private toolResult(
    action: FunctionCallAction,
    result: { output: string | InputContentPart[] } | { error: string },
  ): ToolResultEvent {
    const base = {
      type: "agent.session.input.tool_result" as const,
      turn_id: action.turn_id,
      call_id: action.call_id,
    };
    return "error" in result
      ? { ...base, success: false, error: result.error }
      : { ...base, success: true, output: result.output };
  }

  private async submit(events: SessionInputEvent[]): Promise<void> {
    await this.client.beta.agents.sessions.events.create(
      this.sessionId,
      { events, "Idempotency-Key": randomUUID() },
      { signal: this.runAbort.signal },
    );
    // Only now that the session has the answers do they leave the record.
    for (const event of events) {
      if (event.type === "agent.session.input.tool_result") {
        remember(this.record.answeredCallIds, event.call_id);
        forget(this.record.clientToolCallIds, event.call_id);
        delete this.record.openInterrupts[event.call_id];
      } else if (
        event.type ===
        "agent.session.input.computer_use_approval_request_result"
      ) {
        remember(this.record.answeredCallIds, event.request_id);
        delete this.record.openInterrupts[event.request_id];
      }
    }
  }

  private emitToolResult(toolCallId: string, content: string): void {
    this.emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId,
      content,
      role: "tool",
    } as BaseEvent);
  }

  private async cancelTurn(): Promise<void> {
    // Idle means nothing to cancel, unless this run just started a turn whose
    // events have not arrived yet.
    if (!this.sessionId || (this.sessionStatus === "idle" && !this.progressing))
      return;
    try {
      await this.client.beta.agents.sessions.events.create(this.sessionId, {
        events: [{ type: "agent.session.input.cancel" }],
      });
      this.record.cancelRequestedAt = Date.now();
      // The cancel answers whatever the session was waiting on.
      this.record.openInterrupts = {};
      this.record.clientToolCallIds = [];
    } catch (error) {
      this.deps.reportError(error, "cancel turn");
    }
  }

  private async forgetSession(): Promise<void> {
    const sessionId = this.record.sessionId;
    this.record.sessionId = "";
    try {
      const stored = await this.deps.store.get(this.deps.storeKey);
      if (stored?.sessionId === sessionId)
        await this.deps.store.delete(this.deps.storeKey);
    } catch (error) {
      this.deps.reportError(error, "session store delete");
    }
  }

  private async persist(): Promise<void> {
    if (!this.record.sessionId) return;
    try {
      await this.deps.store.set(this.deps.storeKey, this.record);
    } catch (error) {
      this.deps.reportError(error, "session store write");
    }
  }

  // ---------------------------------------------------------------------------
  // Ending the run

  private finish(outcome?: "cancelled"): void {
    if (this.finished) return;
    this.translator.closeAll();
    this.emit({
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      ...(outcome === "cancelled" ? { outcome: { type: "cancelled" } } : {}),
    } as BaseEvent);
    this.finished = true;
  }

  private finishWithClientWork(): void {
    if (this.finished) return;
    this.translator.closeAll();
    const interrupts = [...this.raised.values()];
    const pending = this.pendingClientCalls();
    this.emit({
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      outcome: interrupts.length
        ? { type: "interrupt", interrupts }
        : {
            type: "success",
            ...(pending.length ? { pendingToolCallIds: pending } : {}),
          },
    } as BaseEvent);
    this.finished = true;
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.translator.closeAll();
    const { message, code } = this.describeError(error);
    this.emit({ type: EventType.RUN_ERROR, message, code } as BaseEvent);
    this.finished = true;
  }

  private describeError(error: unknown): { message: string; code: string } {
    if (error instanceof RunFailure)
      return { message: error.message, code: error.code };
    const apiError = error as {
      status?: number;
      code?: string | null;
      message?: string;
      name?: string;
    };
    if (apiError && typeof apiError.status === "number") {
      this.deps.reportError(error, "OpenAI API request");
      return {
        message: `OpenAI Agents API error (${apiError.status}): ${(apiError.message ?? "request failed").replace(/^\d{3}\s+/, "")}`,
        code: apiError.code ?? `http_${apiError.status}`,
      };
    }
    this.deps.reportError(error, "run");
    return {
      message: "The agent run failed unexpectedly.",
      code: "internal_error",
    };
  }
}
