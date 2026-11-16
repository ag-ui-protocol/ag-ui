import {
  EventType,
  PROTOCOL_VERSION,
  randomUUID,
  type BaseEvent,
  type Context,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
} from "@ag-ui/client";
import type { ModelMessage, ToolSet } from "ai";
import { EventChannel } from "./event-channel";
import { readRunAgentInput, warn, warnAboutProtocolVersion } from "./input";
import { buildInstructions } from "./instructions";
import { INTERRUPTED, convertMessages, type ConvertedMessages, type PendingApproval } from "./messages";
import { jsonEqual } from "./provider-metadata";
import { toClientTools } from "./tools";
import { translateStream, type StreamTextLike, type TranslateOptions } from "./translate";

/** Shared state as AG-UI carries it: any JSON value, usually an object. */
export type AGUIState = Record<string, unknown>;

/**
 * Where a run reads and writes the shared state. A Durable Object agent backs
 * it with `this.state` / `this.setState()`; a plain Worker keeps it for the
 * length of the request.
 */
export interface StateStore<State = AGUIState> {
  get(): State;
  set(state: State): void;
  /** Called with every new state set during the run. Returns an unsubscribe. */
  subscribe(listener: (state: State) => void): () => void;
  /**
   * The state the client had when the last run ended. A run adopts the
   * client's state only when it differs from this (the client changed it),
   * so changes the server made in between (a schedule, another client) are
   * not overwritten by a stale copy. Without it, the client's state wins.
   */
  synced?(): unknown | Promise<unknown>;
  /** Records the state the client has at the end of a run. */
  markSynced?(state: State): void | Promise<void>;
}

/**
 * Where a server records the tool calls it paused for approval, so a resume
 * can only approve calls the model actually made. A Durable Object agent
 * keeps them in its storage.
 */
export interface ApprovalStore {
  load(): PendingApproval[] | Promise<PendingApproval[]>;
  save(approvals: PendingApproval[]): void | Promise<void>;
}

/** A state store that lives as long as the run: the default outside Durable Objects. */
export function memoryStateStore<State>(initial: State): StateStore<State> {
  let state = initial;
  const listeners = new Set<(state: State) => void>();
  return {
    get: () => state,
    set(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One AG-UI run, ready to hand to `streamText`. */
export interface AGUIRun<State = AGUIState> {
  /** The request as the client sent it. */
  readonly input: RunAgentInput;
  /**
   * The HTTP request that started the run (its body already read), for its
   * headers: auth, tracing, headers to forward to the model provider.
   * Undefined for runs over a WebSocket.
   */
  readonly request?: Request;
  /**
   * The conversation as AI SDK model messages: multimodal input, reasoning
   * and provider metadata included, and the previous run's approvals turned
   * into AI SDK tool approvals so `streamText` resumes them.
   */
  readonly messages: ModelMessage[];
  /** The tools the client runs, without `execute`. Spread your own after them. */
  readonly clientTools: ToolSet;
  /** What the application told the agent (`RunAgentInput.context`). */
  readonly context: Context[];
  /** The current shared state. */
  readonly state: State;
  /** Fires when the client cancels the run. Pass it to `streamText`. */
  readonly abortSignal: AbortSignal;
  /**
   * The system instructions for this run: `base`, then the conversation's
   * system messages, the application's context and (unless `state: false`)
   * the shared state.
   */
  instructions(base?: string, options?: { state?: boolean }): string;
  /** Replaces the shared state; the client receives it as a STATE_SNAPSHOT. */
  setState(state: State): void;
  /** Streams an extra event to the client (a CUSTOM event, for instance). */
  emit(event: BaseEvent): void;
}

export type AGUIRunHandler<State = AGUIState> = (
  run: AGUIRun<State>,
) => StreamTextLike | Promise<StreamTextLike>;

export interface RunAGUIOptions<State = AGUIState> {
  /** Aborts the run (client disconnect, explicit cancel). */
  signal?: AbortSignal;
  /** Where shared state lives. Defaults to the state in the request. */
  state?: StateStore<State>;
  /** Where paused approvals are recorded. Without it, a resume trusts the client's history. */
  approvals?: ApprovalStore;
  /** The HTTP request the run came in on, handed to the handler as `run.request`. */
  request?: Request;
}

/**
 * Runs `handler` for one AG-UI request and streams the run as AG-UI events,
 * from RUN_STARTED to RUN_FINISHED or RUN_ERROR. It always ends with one of
 * the two, whatever fails along the way.
 *
 * The input is checked first (members AG-UI does not define are removed, a
 * malformed one is refused), then the previous run's interrupts are settled:
 * answered approvals become AI SDK tool approvals in `run.messages`. A request
 * that is malformed or leaves an approval unanswered is refused before the run
 * starts: the stream is a single RUN_ERROR, and the model is not called.
 */
export async function* runAGUI<State = AGUIState>(
  rawInput: RunAgentInput,
  handler: AGUIRunHandler<State>,
  options: RunAGUIOptions<State> = {},
): AsyncGenerator<BaseEvent> {
  let input: RunAgentInput;
  try {
    input = readRunAgentInput(rawInput);
  } catch (error) {
    yield runError(error, "INVALID_INPUT");
    return;
  }
  warnAboutProtocolVersion(input.protocolVersion);

  const clientToolNames = input.tools.map((tool) => tool.name);
  let converted: ConvertedMessages;
  try {
    const pendingApprovals = options.approvals ? await options.approvals.load() : undefined;
    converted = convertMessages(input.messages, { resume: input.resume, clientToolNames, pendingApprovals });
  } catch (error) {
    yield runError(error, "INTERNAL_ERROR");
    return;
  }
  if (converted.resumeErrors.length > 0) {
    yield runError(converted.resumeErrors.join(" "), "INVALID_RESUME");
    return;
  }
  for (const warning of converted.resumeWarnings) warn(warning);

  yield runStarted(input);
  const channel = new EventChannel();
  let unsubscribe = () => {};
  try {
    const store = options.state ?? memoryStateStore((input.state ?? {}) as State);
    if (options.state && hasState(input.state)) {
      // The client changed its state since the last run (or nothing says
      // otherwise): its edits win.
      const synced = await options.state.synced?.();
      if (synced === undefined || !jsonEqual(input.state, synced)) store.set(input.state as State);
    }
    // The client's copy is stale (the server changed or cleared the state
    // since): send the current one.
    const current = store.get() ?? {};
    if (!jsonEqual(current, input.state ?? {})) yield stateSnapshot(current);
    unsubscribe = store.subscribe((state) => channel.push(stateSnapshot(state)));

    const abortSignal = options.signal ?? new AbortController().signal;
    const run: AGUIRun<State> = {
      input,
      request: options.request,
      messages: converted.messages,
      clientTools: toClientTools(input.tools),
      context: input.context ?? [],
      get state() {
        return store.get();
      },
      abortSignal,
      instructions(base, instructionOptions) {
        return buildInstructions({
          base,
          systemMessages: converted.instructions,
          context: input.context,
          state: instructionOptions?.state === false ? undefined : store.get(),
        });
      },
      setState: (state) => store.set(state),
      emit: (event) => channel.push(event),
    };

    let result: StreamTextLike;
    try {
      result = await handler(run);
    } catch (error) {
      yield* channel.drain();
      if (!abortSignal.aborted) {
        // The approvals this run was resuming stay open: after RUN_ERROR the
        // client still holds their interrupts and answers them again.
        yield runError(error, "AGENT_ERROR");
        return;
      }
      // A handler stopped by the cancel was cancelled, not broken. A
      // cancelled run waits for nothing: the calls it was resuming never ran,
      // and are closed.
      for (const toolCallId of converted.resumed) yield toolCallResult(toolCallId, INTERRUPTED);
      await options.approvals?.save([]);
      yield runFinished(input, { type: "cancelled" });
      return;
    }

    const translation = yield* translate(input, result, {
      clientToolNames,
      channel,
      denials: converted.denials,
      abortSignal,
      resumedToolCallIds: converted.resumed,
    });
    unsubscribe();
    // The previous run's approvals are answered now; record this run's. After
    // an error the record stays: the client answers the same approvals again.
    if (translation.approvals) await options.approvals?.save(translation.approvals);
    await options.state?.markSynced?.(store.get());
    yield translation.terminal;
  } catch (error) {
    // Nothing above may leave the client without a terminal event.
    yield* channel.drain();
    yield runError(error, "INTERNAL_ERROR");
  } finally {
    unsubscribe();
  }
}

/**
 * Streams an AI SDK result as a complete AG-UI run, without the request
 * handling `runAGUI` does (no message conversion, no resume). For callers
 * that already ran `streamText` themselves. The page's tools are
 * `input.tools` unless `clientToolNames` says otherwise; pass `signal` (the
 * one given to `streamText`) so a cancel ends the run as cancelled.
 */
export async function* streamToAGUI(
  rawInput: RunAgentInput,
  result: StreamTextLike,
  options: { clientToolNames?: Iterable<string>; channel?: EventChannel; signal?: AbortSignal } = {},
): AsyncGenerator<BaseEvent> {
  let input: RunAgentInput;
  try {
    input = readRunAgentInput(rawInput);
  } catch (error) {
    yield runError(error, "INVALID_INPUT");
    return;
  }
  warnAboutProtocolVersion(input.protocolVersion);
  yield runStarted(input);
  if (hasState(input.state)) yield stateSnapshot(input.state);
  const { terminal } = yield* translate(input, result, {
    clientToolNames: options.clientToolNames ?? input.tools.map((tool) => tool.name),
    channel: options.channel,
    abortSignal: options.signal,
  });
  yield terminal;
}

/**
 * Streams the translated events. Returns the terminal event (not yet sent)
 * and the approvals to record, or undefined after an error (keep the record).
 */
async function* translate(
  input: RunAgentInput,
  result: StreamTextLike,
  options: Omit<TranslateOptions, "inputMessages">,
): AsyncGenerator<BaseEvent, { terminal: BaseEvent; approvals?: PendingApproval[] }> {
  let translation;
  try {
    translation = yield* translateStream(result.fullStream, { ...options, inputMessages: input.messages });
  } catch (error) {
    return { terminal: runError(error, "STREAM_ERROR") };
  }

  const { outcome, usage, approvals } = translation;
  if (outcome.type === "error") return { terminal: runError(outcome.message, outcome.code, usage) };
  return { terminal: runFinished(input, outcome, usage), approvals };
}

function toolCallResult(toolCallId: string, content: string): BaseEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId: randomUUID(),
    toolCallId,
    content,
    role: "tool",
    timestamp: Date.now(),
  } as BaseEvent;
}

function runStarted(input: RunAgentInput): RunStartedEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    ...(input.parentRunId && { parentRunId: input.parentRunId }),
    input: {
      ...input,
      messages: input.messages ?? [],
      tools: input.tools ?? [],
      context: input.context ?? [],
      state: input.state ?? {},
      forwardedProps: input.forwardedProps ?? {},
    },
  };
}

function runFinished(
  input: RunAgentInput,
  outcome: NonNullable<RunFinishedEvent["outcome"]>,
  usage?: RunFinishedEvent["usage"],
): RunFinishedEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    timestamp: Date.now(),
    outcome: downgradeOutcome(input, outcome),
    ...(usage && usage.length > 0 && { usage }),
  };
}

/**
 * A client that declares no protocol version predates AG-UI 1.0, and the
 * 0.0.x clients reject outcome fields they do not know. AG-UI lets a producer
 * that knows its peer is older leave such additions out, so
 * `pendingToolCallIds` (a 1.0 addition) goes only to 1.0 clients.
 */
function downgradeOutcome(
  input: RunAgentInput,
  outcome: NonNullable<RunFinishedEvent["outcome"]>,
): NonNullable<RunFinishedEvent["outcome"]> {
  if (input.protocolVersion || outcome.type !== "success" || !("pendingToolCallIds" in outcome)) return outcome;
  const { pendingToolCallIds: _pending, ...older } = outcome;
  return older;
}

function runError(error: unknown, code: string, usage?: RunErrorEvent["usage"]): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    message: error instanceof Error ? error.message : String(error),
    code,
    timestamp: Date.now(),
    ...(usage && usage.length > 0 && { usage }),
  };
}

function stateSnapshot(snapshot: unknown): BaseEvent {
  return { type: EventType.STATE_SNAPSHOT, snapshot, timestamp: Date.now() } as BaseEvent;
}

function hasState(state: unknown): boolean {
  if (state === undefined || state === null) return false;
  if (typeof state === "object" && !Array.isArray(state)) return Object.keys(state).length > 0;
  return true;
}
