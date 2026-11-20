import {
  STATE_TOOL,
  primaryThread,
  attachState,
  stateTool,
  stateToolDefinition,
  parseState,
  acceptState,
} from "./state";
import {
  recoverSession,
  recoverChildResults,
  rememberChildCall,
  recoveryFinished,
  RecoveryError,
  type SessionStream,
} from "./recovery";
import { attachContext, ContextDeliveryError } from "./context";
import Anthropic from "@anthropic-ai/sdk";
import { userContent } from "./content";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsUserCustomToolResultEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

/** One block of a custom tool result, as the session API accepts it. */
type ToolResultBlock = NonNullable<
  BetaManagedAgentsUserCustomToolResultEventParams["content"]
>[number];
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { AbstractAgent, EventType, PROTOCOL_VERSION } from "@ag-ui/client";
import type { BaseEvent, Message, RunAgentInput, Tool } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  BEST_EFFORT_SEND_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
} from "./constants";
import { reportSwallowedFailure } from "./report";
import { InMemorySessionStore } from "./sessions";
import {
  customToolFrom,
  normalizeToolName,
  toolsFingerprint,
  type CustomToolParams,
} from "./tools";
import { runTurn, type TurnOutcome } from "./turn";
import type {
  BackendCustomTool,
  ManagedAgentsAgentConfig,
  SessionRecord,
  SessionStore,
} from "./types";

type OverrideTools = NonNullable<
  Extract<
    SessionCreateParams["agent"],
    { type: "agent_with_overrides" }
  >["tools"]
>;

/** Validate the same newest user message that first contact will send. */
const hasFirstContactUserContent = (messages: Message[]): boolean => {
  const message = messages.findLast((message) => message.role === "user");
  return message !== undefined && userContent(message).length > 0;
};

/** Send supported tool parts without flattening or dropping them. */
const toolResultBlocks = (
  message: Extract<Message, { role: "tool" }>,
): ToolResultBlock[] => {
  if (typeof message.content === "string") {
    const text = [message.content, message.error].filter(Boolean).join("\n");
    return text ? [{ type: "text", text }] : [];
  }
  const blocks = userContent(message);
  if (message.error) blocks.push({ type: "text", text: message.error });
  // Managed Agents accepts no result blocks, but rejects an empty text block.
  // Keep nonempty text (including whitespace) and supported media unchanged.
  return blocks.filter((block) => block.type !== "text" || block.text !== "");
};

const runError = (message: string, code: string): BaseEvent =>
  ({ type: EventType.RUN_ERROR, message, code }) as BaseEvent;

/**
 * The only thing a client is told about a failure this integration did not
 * author. An SDK, session-store or API exception can carry session ids, request
 * paths, backend hostnames or credentials, and the AG-UI client is not
 * necessarily a trusted operator surface — so the cause goes to `onError` and
 * the client gets this plus the machine-readable `code`.
 */
const RUN_FAILED_MESSAGE = "The run failed.";

/**
 * An AG-UI agent backed by Claude Managed Agents. Each AG-UI thread maps to
 * one managed session; each run drives one turn of that session.
 */
export class ManagedAgentsAgent extends AbstractAgent {
  private readonly client: Anthropic;
  private readonly store: SessionStore;
  private readonly backendTools: Map<string, BackendCustomTool>;
  private currentRunAbort: AbortController | null = null;

  // Keyed by session-store identity: the store is the unit of tenancy, so
  // agents (and clones) sharing a store serialize runs per thread, while
  // per-caller stores keep one caller's runs from blocking another's.
  // Keys within a store's set are scoped to this managed agent.
  private static busyThreadsByStore = new WeakMap<SessionStore, Set<string>>();

  private get busyThreads(): Set<string> {
    let set = ManagedAgentsAgent.busyThreadsByStore.get(this.store);
    if (!set) {
      set = new Set<string>();
      ManagedAgentsAgent.busyThreadsByStore.set(this.store, set);
    }
    return set;
  }

  constructor(private config: ManagedAgentsAgentConfig) {
    super(config);
    this.client = config.client ?? new Anthropic();
    this.store = config.sessionStore ?? new InMemorySessionStore();
    this.backendTools = new Map(
      (config.backendTools ?? []).map((tool) => [
        normalizeToolName(tool.name),
        tool,
      ]),
    );
  }

  /**
   * A copy of this agent that carries its conversation with it.
   *
   * `super.clone()` provides the AbstractAgent half — thread ID, messages,
   * state, subscribers, middleware, debug settings — the way `HttpAgent.clone()`
   * does; constructing a fresh instance instead would silently reset all of it.
   * The client and session store are shared on purpose, so per-run copies see
   * the same thread↔session mappings.
   */
  public clone(): ManagedAgentsAgent {
    const cloned = super.clone() as ManagedAgentsAgent;
    const own = cloned as unknown as {
      config: ManagedAgentsAgentConfig;
      client: Anthropic;
      store: SessionStore;
      backendTools: Map<string, BackendCustomTool>;
      currentRunAbort: AbortController | null;
    };
    // Resolved rather than raw, so a clone of a clone keeps the same client and
    // store instead of constructing new ones from an incomplete config.
    own.config = {
      ...this.config,
      client: this.client,
      sessionStore: this.store,
    };
    own.client = this.client;
    own.store = this.store;
    own.backendTools = this.backendTools;
    // The copy is not mid-run, so it must not be able to abort this one's.
    own.currentRunAbort = null;
    return cloned;
  }

  /**
   * Report a swallowed failure. A broken hook must never break the run: see
   * {@link reportSwallowedFailure}, which absorbs both a synchronous throw and
   * an async hook's rejection.
   *
   * Returns a promise a caller on an async path can await, so an async hook's
   * telemetry is not left racing the end of the run.
   */
  private report(
    operation: string,
    error: unknown,
    ids: { sessionId?: string; threadId?: string } = {},
  ): Promise<void> {
    return reportSwallowedFailure(this.config.onError, operation, error, ids);
  }

  public abortRun() {
    this.currentRunAbort?.abort();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const disconnect = new AbortController();
      this.currentRunAbort = disconnect;
      const timeoutMs = this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([disconnect.signal, timeout]);

      // A run emits exactly one terminal event. Something failing after the
      // turn already reported an outcome — a session store that rejects the
      // closing write, say — must not append a second RUN_ERROR behind a
      // RUN_ERROR or a RUN_FINISHED. The dropped error still reaches the
      // error hook so it is not lost.
      let terminated = false;
      const emit = (event: BaseEvent) => {
        if (
          event.type === EventType.RUN_ERROR ||
          event.type === EventType.RUN_FINISHED
        ) {
          if (terminated) {
            if (event.type === EventType.RUN_ERROR) {
              this.report(
                "dropped_terminal_event",
                new Error(
                  String((event as { message?: unknown }).message ?? ""),
                ),
                {
                  threadId: input.threadId,
                },
              );
            }
            return;
          }
          terminated = true;
        }
        subscriber.next(event);
      };

      this.runTurnForInput(input, emit, signal)
        .catch(async (err) => {
          if (disconnect.signal.aborted) {
            // The client went away, so there is nobody to emit to — but the run
            // may have failed for a reason worth knowing about, and this is its
            // only trace. Awaited so an async hook's telemetry is not left
            // racing the run's completion.
            await this.report("run_after_disconnect", err, {
              threadId: input.threadId,
            });
            return;
          }
          if (
            err instanceof RecoveryError ||
            err instanceof ContextDeliveryError
          ) {
            emit(runError(err.message, err.code));
            return;
          }
          if (timeout.aborted) {
            emit(
              runError(
                `The turn exceeded the ${timeoutMs / 1000}s limit and was interrupted.`,
                "turn_timeout",
              ),
            );
            return;
          }
          // Detail to the hook, not to the client: see RUN_FAILED_MESSAGE.
          await this.report("run_failed", err, { threadId: input.threadId });
          emit(runError(RUN_FAILED_MESSAGE, "run_failed"));
        })
        .finally(() => subscriber.complete());

      return () => {
        disconnect.abort();
        if (this.currentRunAbort === disconnect) this.currentRunAbort = null;
      };
    });
  }

  private async runTurnForInput(
    input: RunAgentInput,
    emit: (event: BaseEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // RunAgentInput is not validated at runtime; a body without `messages` or
    // `tools` must read as an empty run, not a TypeError.
    input = {
      ...input,
      messages: input.messages ?? [],
      tools: input.tools ?? [],
    };
    const { threadId, runId } = input;
    let record: SessionRecord | undefined;
    // One key for the session store and the busy-run gate, so a stored session
    // and the gate that serializes access to it can never disagree.
    const key = this.sessionKey(threadId);
    let sessionId: string | undefined;
    let recoveredStream: SessionStream | undefined;
    let recoveredAnswerIds: Set<string> | undefined;
    let recovering = false;
    let sessionGateKey: string | undefined;
    emit({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
      protocolVersion: PROTOCOL_VERSION,
      input,
    } as BaseEvent);

    // A blank thread id is not a thread: every caller that omitted one would
    // share a single key, and so a single managed session and its history.
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      emit(
        runError(
          "This run has no thread id. Every run must carry a non-empty threadId.",
          "invalid_thread_id",
        ),
      );
      return;
    }

    if (this.busyThreads.has(key)) {
      emit(
        runError(
          "A run is already in progress on this thread.",
          "run_in_progress",
        ),
      );
      return;
    }
    this.busyThreads.add(key);
    try {
      // Validate reserved names on every run, including imported/approval-only runs.
      this.customTools(input.tools);
      recovering = Boolean(await this.store.get(key));
      record = await this.getOrCreateSession(
        key,
        threadId,
        input,
        emit,
        signal,
      );
      if (!record) {
        const sendable = this.hasSendableContent(input.messages);
        emit(
          runError(
            sendable
              ? "A tool result arrived for a thread with no session."
              : "There is nothing to send: this run has no user message or tool result.",
            sendable ? "tool_result_without_session" : "empty_run",
          ),
        );
        return;
      }
      // A local the closures below can close over without re-narrowing.
      const session = record;
      const output = emit;
      const delivered = new Set([
        ...(session.deliveredChildResultIds ?? []),
        ...input.messages.flatMap((message) =>
          message.role === "tool" ? [message.toolCallId] : [],
        ),
      ]);
      session.deliveredChildResultIds = [...delivered];
      await this.store.set(key, session);
      emit = (event) => {
        if (event.type === EventType.RAW) {
          rememberChildCall(
            session,
            (event as import("@ag-ui/client").RawEvent).event,
          );
        }
        if (event.type === EventType.TOOL_CALL_RESULT) {
          const id = (event as import("@ag-ui/client").ToolCallResultEvent)
            .toolCallId;
          if (session.childToolCalls?.[id]) {
            if (delivered.has(id)) return;
            delivered.add(id);
            session.deliveredChildResultIds = [...delivered];
          }
        }
        output(event);
      };
      const reconcileChildren = async () => {
        await recoverChildResults(this.client, session, signal, emit, () =>
          this.store.set(key, session),
        );
        await this.store.set(key, session);
      };
      sessionId = session.sessionId;
      const nativeKey = `session:${sessionId}`;
      if (this.busyThreads.has(nativeKey))
        throw new RecoveryError(
          "run_in_progress",
          "A run is already in progress on this native session.",
        );
      this.busyThreads.add(nativeKey);
      sessionGateKey = nativeKey;
      recovering ||= Boolean(session.preserveTools);
      if (session.ended)
        throw new RecoveryError(
          "session_ended",
          "The original managed session has ended.",
        );
      let running = false;
      if (recovering) {
        const known = new Set(
          input.messages.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).map((call) => call.id)
              : [],
          ),
        );
        const clientTools = new Map(
          input.tools.map((tool) => [normalizeToolName(tool.name), tool.name]),
        );
        const recovery = await recoverSession(
          this.client,
          session,
          signal,
          emit,
          known,
          clientTools,
          new Map(
            input.messages.map((message) => [
              message.id,
              "content" in message ? message.content : undefined,
            ]),
          ),
        );
        recoveredStream = recovery.stream;
        recoveredAnswerIds = recovery.answeredIds;
        running = recovery.running;
        await this.store.set(key, session);
        emit({
          type: EventType.CUSTOM,
          name: "managed_agents.session",
          value: {
            sessionId: session.sessionId,
            threadId,
            ...(session.sessionThreadId
              ? { sessionThreadId: session.sessionThreadId }
              : {}),
          },
        } as BaseEvent);
        // Validate every approval identity before recovery can send a state result.
        // Rebuild outbound afterward because completing reserved calls changes pending IDs.
        this.outboundEvents(session, input.messages, input.resume);
        // A native state request may outlive this adapter process. Complete it on
        // its original ID; it is never a browser approval or a replacement call.
        const completedStateCalls = new Set<string>();
        for (const call of recovery.pending) {
          if (
            call.type !== "agent.custom_tool_use" ||
            call.name !== STATE_TOOL ||
            session.sessionThreadId
          )
            continue;
          if (
            call.session_thread_id &&
            call.session_thread_id !==
              (await primaryThread(this.client, session, signal))
          )
            continue;
          if (session.preserveTools)
            await this.ensureImportedStateTool(session, signal, false);
          let text: string;
          let isError = false;
          try {
            text = await stateTool(session).handler(call.input);
          } catch (error) {
            text = error instanceof Error ? error.message : String(error);
            isError = true;
          }
          const stateResult: BetaManagedAgentsEventParams[] = [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: call.id,
              content: [{ type: "text", text }],
              is_error: isError,
            },
          ];
          // This real result can resume inference before ordinary outbound
          // answers are built. Deliver required context in this same batch.
          const recoveredContext = attachContext(
            stateResult,
            input.context,
            session,
          );
          await this.client.beta.sessions.events.send(
            session.sessionId,
            { events: stateResult },
            { signal },
          );
          if (recoveredContext)
            session.runtimeContext = recoveredContext.snapshot;
          const commit =
            !isError && parseState([{ type: "text", text }], session);
          if (commit) acceptState(session, commit);
          completedStateCalls.add(call.id);
          recovery.answeredIds.add(call.id);
          session.pendingClientToolUseIds =
            session.pendingClientToolUseIds.filter((id) => id !== call.id);
          await this.store.set(key, session);
          if (!known.has(call.id) && !recovery.replayedIds.has(call.id)) {
            emit({
              type: EventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: STATE_TOOL,
            } as BaseEvent);
            emit({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: call.id,
              delta: JSON.stringify(call.input ?? {}),
            } as BaseEvent);
            emit({
              type: EventType.TOOL_CALL_END,
              toolCallId: call.id,
            } as BaseEvent);
          }
          emit({
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: call.id,
            messageId: call.id + ":result",
            content: text,
            role: "tool",
          } as BaseEvent);
          running = true;
        }
        // Imported history already contains these calls. Re-emit only when absent.
        for (const event of recovery.pending) {
          if (
            event.type !== "agent.custom_tool_use" ||
            completedStateCalls.has(event.id) ||
            known.has(event.id) ||
            recovery.replayedIds.has(event.id)
          )
            continue;
          emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: event.id,
            toolCallName: clientTools.get(event.name) ?? event.name,
          } as BaseEvent);
          emit({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: event.id,
            delta: JSON.stringify(event.input ?? {}),
          } as BaseEvent);
          emit({
            type: EventType.TOOL_CALL_END,
            toolCallId: event.id,
          } as BaseEvent);
        }
      }
      const outbound = this.outboundEvents(
        session,
        input.messages,
        input.resume,
      );
      const contextDelivery = attachContext(
        outbound.events,
        input.context,
        session,
      );
      const stateDelivery = attachState(outbound.events, input.state, session);
      const commitState = async () => {
        if (stateDelivery && acceptState(session, stateDelivery.commit)) {
          await this.store.set(key, session);
          emit({
            type: EventType.STATE_SNAPSHOT,
            snapshot: session.sharedState!.state,
          } as BaseEvent);
        }
      };
      if (session.sharedState)
        emit({
          type: EventType.STATE_SNAPSHOT,
          snapshot: session.sharedState.state,
        } as BaseEvent);

      // Owned sessions may change their catalog on a new user turn. Reconnects,
      // pending-result delivery and adopted native sessions retain their tools.
      if (
        !session.preserveTools &&
        outbound.stillParked.length === 0 &&
        outbound.events.some((event) => event.type === "user.message")
      ) {
        await this.syncClientTools(session, input.tools, signal);
      }
      if (
        session.preserveTools &&
        !session.sessionThreadId &&
        outbound.stillParked.length === 0 &&
        outbound.events.some((e) => e.type === "user.message")
      ) {
        await this.ensureImportedStateTool(session, signal);
      }
      if (
        session.sessionThreadId &&
        outbound.events.some((event) => event.type === "user.message")
      ) {
        throw new RecoveryError(
          "child_thread_followup_unsupported",
          "Send new messages to the primary session; child threads only accept pending tool answers.",
        );
      }
      if (
        outbound.stillParked.length > 0 ||
        (outbound.events.length === 0 && !running)
      ) {
        if (outbound.events.length)
          await this.client.beta.sessions.events.send(
            session.sessionId,
            { events: outbound.events },
            { signal },
          );
        if (outbound.events.length) await commitState();
        if (contextDelivery) session.runtimeContext = contextDelivery.snapshot;
        session.pendingClientToolUseIds =
          session.pendingClientToolUseIds.filter((id) =>
            outbound.stillParked.includes(id),
          );
        session.pendingConfirmations = session.pendingConfirmations?.filter(
          (call) => outbound.stillParked.includes(call.id),
        );
        await this.store.set(key, session);
        await reconcileChildren();
        emit(recoveryFinished(session, threadId, runId));
        return;
      }

      const outcome = await runTurn({
        client: this.client,
        sessionId: session.sessionId,
        outbound: outbound.events,
        stream: recoveredStream,
        acknowledgedToolUseIds: recoveredAnswerIds,
        sessionThreadId: session.sessionThreadId,
        preservePending: recovering,
        onNativeEvent: async (id) => {
          session.lastEventId = id;
          await this.store.set(key, session);
        },
        onConfirmationPark: async (call) => {
          session.pendingConfirmations = [
            ...(session.pendingConfirmations ?? []).filter(
              (item) => item.id !== call.id,
            ),
            call,
          ];
          await this.store.set(key, session);
        },
        // Persist each delivery as soon as it lands, so a failure or
        // interruption later in the turn does not re-post it next run: the
        // tool results resume the session even if the follow-ups then fail.
        onResultsSent: async () => {
          if (stateDelivery?.withResults) await commitState();
          if (contextDelivery?.withResults)
            session.runtimeContext = contextDelivery.snapshot;
          session.pendingClientToolUseIds = [];
          session.pendingConfirmations = [];
          await this.store.set(key, session);
        },
        onFollowUpsSent: async () => {
          if (stateDelivery && !stateDelivery.withResults) await commitState();
          if (contextDelivery && !contextDelivery.withResults)
            session.runtimeContext = contextDelivery.snapshot;
          if (outbound.lastUserMessageId)
            session.lastUserMessageId = outbound.lastUserMessageId;
          await this.store.set(key, session);
        },
        // Persist a park the moment the call is handed to the UI. A later
        // event can fail the turn before the session confirms the park, and
        // the remote session would then wait on an ID nothing remembers.
        onClientPark: async (toolUseId) => {
          if (session.pendingClientToolUseIds.includes(toolUseId)) return;
          session.pendingClientToolUseIds = [
            ...session.pendingClientToolUseIds,
            toolUseId,
          ];
          await this.store.set(key, session);
        },
        clientTools: new Map(
          (input.tools ?? []).map((tool) => [
            normalizeToolName(tool.name),
            tool.name,
          ]),
        ),
        backendTools: new Map([
          ...this.backendTools,
          [STATE_TOOL, stateTool(session)],
        ]),
        allowBackendTool: async (name, nativeThread) => {
          if (name !== STATE_TOOL) return true;
          if (
            session.sessionThreadId ||
            (nativeThread &&
              nativeThread !==
                (await primaryThread(this.client, session, signal)))
          )
            return false;
          if (session.preserveTools)
            await this.ensureImportedStateTool(session, signal, false);
          return true;
        },
        onBackendResultSent: async (_id, name, text, isError) => {
          if (name !== STATE_TOOL || isError) return;
          const commit = parseState([{ type: "text", text }], session);
          if (commit && acceptState(session, commit)) {
            await this.store.set(key, session);
            emit({
              type: EventType.STATE_SNAPSHOT,
              snapshot: commit.state,
            } as BaseEvent);
          }
        },
        toolConfirmation: recovering ? undefined : this.config.toolConfirmation,
        streamDeltas: this.config.streamDeltas ?? true,
        onError: this.config.onError,
        emit,
        signal,
      });

      await this.recordOutcome(key, session, outcome);
      if (outcome.status !== "errored") {
        await reconcileChildren();
        emit(recoveryFinished(session, threadId, runId));
      }
    } catch (err) {
      // Interrupt the session while the busy gate is still held, so a user
      // who resends right away is not interrupted by this run's teardown.
      if (signal.aborted && sessionId && !recovering) {
        const interrupted = await this.client.beta.sessions.events
          .send(
            sessionId,
            { events: [{ type: "user.interrupt" }] },
            { signal: AbortSignal.timeout(BEST_EFFORT_SEND_TIMEOUT_MS) },
          )
          .then(() => true)
          .catch(async (error: unknown) => {
            await this.report("interrupt", error, { sessionId, threadId });
            return false;
          });
        // A thrown turn never reaches recordOutcome, so reconcile here: the
        // landed interrupt cancelled the wait, and a park recorded during this
        // turn would otherwise be answered against a call that no longer exists.
        if (interrupted && record)
          await this.forgetParkedCalls(key, record, { sessionId, threadId });
      }
      throw err;
    } finally {
      recoveredStream?.controller.abort();
      if (sessionGateKey) this.busyThreads.delete(sessionGateKey);
      this.busyThreads.delete(key);
    }
  }

  /**
   * Drop the parked tool calls recorded for this thread, because the session was
   * interrupted and will never answer them. Best-effort: the run is already
   * ending, and a store that refuses the write must not replace the error that
   * got us here.
   */
  private async forgetParkedCalls(
    key: string,
    record: SessionRecord,
    ids: { sessionId?: string; threadId?: string } = {},
  ): Promise<void> {
    if (record.pendingClientToolUseIds.length === 0) return;
    record.pendingClientToolUseIds = [];
    try {
      await this.store.set(key, record);
    } catch (error) {
      await this.report("forget_parked_calls", error, ids);
    }
  }

  /** Whether a new thread carries supported user content or a tool result. */
  private hasSendableContent(messages: Message[]): boolean {
    return (
      hasFirstContactUserContent(messages) ||
      messages.some((message) => message.role === "tool")
    );
  }

  /**
   * The key that identifies this thread's state, in the session store and in
   * the busy-run gate alike, so two agents sharing one store neither adopt each
   * other's sessions nor serialize against each other's threads.
   *
   * Every field baked into the remote session at creation is part of the key:
   * none of them can be re-checked or changed on resume, so an agent must never
   * inherit a session created with a different environment, pinned version or
   * vault set. Each is length-prefixed so no two combinations can collide —
   * plain concatenation would let a `managedAgentId` of `support:beta` with
   * thread `t1` and one of `support` with thread `beta:t1` share one record.
   * The thread id is last, so it needs no prefix and may contain anything.
   */
  private sessionKey(threadId: string): string {
    const { managedAgentId, agentVersion, environmentId, vaultIds } =
      this.config;
    const field = (value: string) => `${value.length}:${value}|`;
    return (
      field(managedAgentId) +
      field(agentVersion === undefined ? "" : String(agentVersion)) +
      field(environmentId) +
      // Sorted: the same vaults in a different order are the same session.
      field([...(vaultIds ?? [])].sort().join(",")) +
      threadId
    );
  }

  /**
   * Reconcile the record with how the turn ended. An errored turn keeps
   * whatever `onClientPark` already persisted: the remote session is still
   * parked on those calls and the next run has to answer them.
   */
  private async recordOutcome(
    key: string,
    record: SessionRecord,
    outcome: TurnOutcome,
  ): Promise<void> {
    if (outcome.status === "errored") {
      if (outcome.sessionEnded) {
        record.ended = true;
        await this.store.set(key, record);
      }
      // An interrupt that landed cancelled whatever the session was waiting on,
      // so a park recorded during this turn is no longer answerable: posting a
      // result for it next run is rejected as stale and wedges the thread.
      else if (outcome.sessionInterrupted)
        await this.forgetParkedCalls(key, record);
      return;
    }
    if (outcome.status === "parked") {
      record.pendingClientToolUseIds = outcome.clientToolUseIds;
      await this.store.set(key, record);
      return;
    }
    // The session went idle on end_turn: nothing is awaited any more.
    if (
      record.pendingClientToolUseIds.length > 0 ||
      record.pendingConfirmations?.length
    ) {
      record.pendingClientToolUseIds = [];
      record.pendingConfirmations = [];
      await this.store.set(key, record);
    }
  }

  /**
   * Work out what to post into the session for this run: results for any
   * tool calls the frontend was asked to run, plus every user message not
   * yet delivered (in order).
   */
  private outboundEvents(
    record: SessionRecord,
    messages: Message[],
    resume: RunAgentInput["resume"] = [],
  ): {
    events: BetaManagedAgentsEventParams[];
    stillParked: string[];
    lastUserMessageId?: string;
  } {
    const toolResult = (
      toolUseId: string,
      content: ToolResultBlock[],
      isError: boolean,
    ): BetaManagedAgentsEventParams => ({
      type: "user.custom_tool_result",
      custom_tool_use_id: toolUseId,
      content,
      is_error: isError,
    });

    const answered: BetaManagedAgentsEventParams[] = [];
    const pending = new Set(record.pendingClientToolUseIds);
    const confirmations = new Set(
      (record.pendingConfirmations ?? []).map((call) => call.id),
    );
    for (const entry of resume ?? []) {
      if (!confirmations.has(entry.interruptId))
        throw new RecoveryError(
          "invalid_resume",
          "The confirmation does not match a pending request.",
        );
      const result =
        entry.status === "cancelled"
          ? "deny"
          : entry.status === "resolved"
            ? entry.payload
            : undefined;
      if (result !== "allow" && result !== "deny")
        throw new RecoveryError(
          "invalid_resume",
          "A confirmation must be allow or deny.",
        );
      answered.push({
        type: "user.tool_confirmation",
        tool_use_id: entry.interruptId,
        result,
      });
      confirmations.delete(entry.interruptId);
    }
    for (const message of messages) {
      if (message.role !== "tool" || !pending.has(message.toolCallId)) continue;
      answered.push(
        toolResult(
          message.toolCallId,
          toolResultBlocks(message),
          Boolean(message.error),
        ),
      );
      pending.delete(message.toolCallId);
    }

    // User messages after the last delivered one; on first contact, just the newest.
    let lastUserMessageId: string | undefined;
    const followUps: BetaManagedAgentsEventParams[] = [];
    const userMessages = messages.filter((message) => message.role === "user");
    const deliveredIndex = userMessages.findIndex(
      (message) => message.id === record.lastUserMessageId,
    );
    const undelivered =
      deliveredIndex >= 0
        ? userMessages.slice(deliveredIndex + 1)
        : userMessages.slice(-1);
    for (const message of undelivered) {
      const content = userContent(message);
      if (!content.length) continue;
      followUps.push({
        type: "user.message",
        content,
      });
      lastUserMessageId = message.id;
    }

    const stillParked = [...pending, ...confirmations];
    // A new message is held until every pending request has an explicit answer.
    return {
      events: [...answered, ...(stillParked.length ? [] : followUps)],
      stillParked,
      lastUserMessageId: stillParked.length ? undefined : lastUserMessageId,
    };
  }

  private async getOrCreateSession(
    key: string,
    threadId: string,
    input: RunAgentInput,
    emit: (event: BaseEvent) => void,
    signal: AbortSignal,
  ): Promise<SessionRecord | undefined> {
    const existing = await this.store.get(key);
    if (existing) return existing;
    const binding = await this.config.resolveSession?.(threadId);
    if (binding) {
      if (!binding.sessionId.trim())
        throw new RecoveryError(
          "invalid_session",
          "An authorized session ID is required.",
        );
      const adopted: SessionRecord = {
        ...binding,
        preserveTools: true,
        toolNames: [],
        pendingClientToolUseIds: [],
        lastUserMessageId:
          binding.lastUserMessageId ??
          input.messages.findLast((message) => message.role === "user")?.id,
      };
      await this.store.set(key, adopted);
      return adopted;
    }

    // A tool result only answers a pending call on an existing session;
    // never create a session to receive one.
    if (!hasFirstContactUserContent(input.messages)) return undefined;

    // The busy-thread gate serializes runs per thread, so creation cannot race.
    const record = await this.createSession(
      threadId,
      input.tools ?? [],
      signal,
    );
    await this.store.set(key, record);
    emit({
      type: EventType.CUSTOM,
      name: "managed_agents.session",
      value: { sessionId: record.sessionId, threadId },
    } as BaseEvent);
    return record;
  }

  /**
   * Create the managed session for a thread. Every API call here takes the run's
   * signal, so `turnTimeoutMs` (and a client disconnect) really do bound the
   * work done while the thread's run gate is held.
   */
  private async createSession(
    threadId: string,
    clientTools: Tool[],
    signal: AbortSignal,
  ): Promise<SessionRecord> {
    const { managedAgentId, agentVersion, environmentId } = this.config;
    const customTools = this.customTools(clientTools);
    const title =
      this.config.sessionTitle?.(threadId) ?? `AG-UI thread ${threadId}`;
    const agentRef = {
      id: managedAgentId,
      ...(agentVersion !== undefined && { version: agentVersion }),
    };

    // The reserved state tool is always installed alongside the agent's tools.
    const registered = await this.mergedTools(customTools, signal);
    const agent: SessionCreateParams["agent"] = {
      type: "agent_with_overrides",
      ...agentRef,
      tools: registered,
    };

    const session = await this.client.beta.sessions.create(
      {
        agent,
        environment_id: environmentId,
        title,
        ...(this.config.vaultIds?.length
          ? { vault_ids: this.config.vaultIds }
          : {}),
      },
      { signal },
    );
    return {
      sessionId: session.id,
      toolNames: customTools.map((tool) => tool.name),
      toolDefinitionsFingerprint: toolsFingerprint(registered ?? []),
      pendingClientToolUseIds: [],
    };
  }

  /**
   * Frontend tools plus configured backend tools, as custom tool definitions.
   * Keyed by normalized name: on a collision the last definition wins, and
   * a frontend tool always beats a backend tool of the same name, matching
   * dispatch order in the turn loop.
   */
  private customTools(clientTools: Tool[]): CustomToolParams[] {
    const byName = new Map<string, CustomToolParams>();
    for (const tool of this.config.backendTools ?? []) {
      byName.set(normalizeToolName(tool.name), customToolFrom(tool));
    }
    for (const tool of clientTools) {
      const custom = customToolFrom(tool);
      byName.set(custom.name, custom);
    }
    if (byName.has(STATE_TOOL))
      throw new Error("Reserved shared state tool name collision.");
    byName.set(STATE_TOOL, stateToolDefinition());
    return [...byName.values()];
  }

  private async ensureImportedStateTool(
    record: SessionRecord,
    signal: AbortSignal,
    allowAppend = true,
  ) {
    const native = await this.client.beta.sessions.retrieve(
      record.sessionId,
      {},
      { signal },
    );
    const tools = native.agent?.tools;
    if (!Array.isArray(tools))
      throw new Error("Native session tool catalog is unavailable.");
    const reserved = tools.filter(
      (tool) => "name" in tool && tool.name === STATE_TOOL,
    );
    if (reserved.length > 1)
      throw new Error("Duplicate reserved shared state tool definitions.");
    const existing = reserved[0];
    const definition = stateToolDefinition();
    if (existing) {
      if (toolsFingerprint([existing]) !== toolsFingerprint([definition]))
        throw new Error("Reserved shared state tool name collision.");
      return;
    }
    if (!allowAppend)
      throw new Error("Imported session has no compatible shared state tool.");
    await this.client.beta.sessions.update(
      record.sessionId,
      { agent: { tools: [...tools, definition] } },
      { signal },
    );
  }

  /**
   * Keep the session's full replacement tool list aligned with this run.
   *
   * The fingerprint covers the merged list, not just the custom tools: an
   * override session's list is a full replacement frozen at the last update, so
   * editing the agent's own tools in the Console changes what the session should
   * hold while every custom tool stays identical. Comparing custom tools alone
   * declared that a match and left the session on a stale list indefinitely.
   *
   * The cost is re-reading the agent's tools once per run for a session that
   * uses overrides, including the reserved shared-state tool.
   */
  private async syncClientTools(
    record: SessionRecord,
    clientTools: Tool[],
    signal: AbortSignal,
  ): Promise<void> {
    const desired = this.customTools(clientTools);
    const registered = await this.mergedTools(desired, signal);
    const fingerprint = toolsFingerprint(registered);
    if (record.toolDefinitionsFingerprint === fingerprint) return;

    await this.client.beta.sessions.update(
      record.sessionId,
      { agent: { tools: registered } },
      { signal },
    );
    record.toolNames = desired.map((tool) => tool.name);
    record.toolDefinitionsFingerprint = fingerprint;
  }

  /**
   * The agent's own tools plus `custom` tools, without duplicate names.
   * Overrides replace the whole list, so the agent's tools are carried
   * along, but a custom tool of the same name wins over the agent's copy.
   */
  private async mergedTools(
    custom: CustomToolParams[],
    signal: AbortSignal,
  ): Promise<OverrideTools> {
    const names = new Set(custom.map((tool) => tool.name));
    const baseTools = await this.baseTools(signal);
    const reserved = baseTools.filter(
      (tool) => "name" in tool && tool.name === STATE_TOOL,
    );
    if (
      reserved.length > 1 ||
      (reserved.length === 1 &&
        toolsFingerprint(reserved) !==
          toolsFingerprint([stateToolDefinition()]))
    )
      throw new Error("Reserved shared state tool name collision.");
    const base = baseTools.filter(
      (tool) => tool.type !== "custom" || !names.has(tool.name),
    );
    return [...base, ...custom];
  }

  /** The tools defined on the managed agent itself, fetched fresh so console edits apply. */
  private async baseTools(signal: AbortSignal): Promise<OverrideTools> {
    const agent = await this.client.beta.agents.retrieve(
      this.config.managedAgentId,
      this.config.agentVersion !== undefined
        ? { version: this.config.agentVersion }
        : undefined,
      { signal },
    );
    // The read shape is structurally compatible with the params shape.
    return agent.tools as unknown as OverrideTools;
  }
}
