import { defaultApplyEvents } from "@/apply/default";
import {
  Message,
  State,
  RunAgentInput,
  BaseEvent,
  AgentCapabilities,
  Interrupt,
  EventType,
  MessagesSnapshotEvent,
  RunErrorEvent,
  // The version this client declares and judges a producer's declaration
  // against, generated from the schema's $id rather than written beside it.
  PROTOCOL_VERSION,
} from "@ag-ui/core";

import {
  AgentConfig,
  AgentDebugConfig,
  HistoryMode,
  MessageFilter,
  RunAgentParameters,
  ResolvedAgentDebugConfig,
  resolveAgentDebugConfig,
} from "./types";
import { DebugLogger, createDebugLogger } from "@/debug-logger";
import { v4 as uuidv4 } from "uuid";
import { structuredClone_ } from "@/utils";
import { compareVersions, validate as validateVersion } from "compare-versions";
import { catchError, filter, map, tap } from "rxjs/operators";
import { finalize } from "rxjs/operators";
import { takeUntil } from "rxjs/operators";
import {
  pipe,
  Observable,
  from,
  of,
  EMPTY,
  Subject,
  defer,
  concatWith,
  throwError,
  Subscription,
} from "rxjs";
import { verifyEvents } from "@/verify";
import { convertToLegacyEvents } from "@/legacy/convert";
import { LegacyRuntimeProtocolEvent } from "@/legacy/types";
import { lastValueFrom } from "rxjs";
import { transformChunks } from "@/chunks";
import { enforceEvents } from "@/enforce";
import {
  CompatibilityBoundary,
  compatibilityBoundaryOperator,
} from "@/middleware/compatibility-boundary";
import { AgentStateMutation, AgentSubscriber, runSubscribersWithMutation } from "./subscriber";
import { AGUIConnectNotImplementedError, AGUIError } from "@ag-ui/core";
import { isInterruptExpired } from "@/interrupts";
import {
  Middleware,
  MiddlewareFunction,
  FunctionMiddleware,
  BackwardCompatibility_0_0_39,
  BackwardCompatibility_0_0_45,
  BackwardCompatibility_0_0_57,
} from "@/middleware";
import packageJson from "../../package.json";


/** The maxVersion deprecation warns once per process, not once per call. */
let warnedDeprecatedMaxVersion = false;

/**
 * Inputs that runAgent() is starting. onInitialize() checks resume answers
 * against pending interrupts only for these. Every other caller, such as
 * connectAgent(), only reads the thread's history and answers nothing, so an
 * interrupted thread must still connect. The check stays inside onInitialize()
 * because subclasses reconcile pending interrupts there before calling super.
 * A module WeakSet, not a field, because clone() skips field initializers.
 */
const runInputs = new WeakSet<RunAgentInput>();

/**
 * The producer's RUN_STARTED declaration, judged against what this client
 * speaks. Older or absent is the downgrade signal the versioning rules expect
 * a consumer to notice quietly; NEWER means material this client may be
 * stripping, and that deserves a voice.
 *
 * The grammar is exactly the published one — two numeric components — checked
 * BEFORE any comparison: compareVersions would happily read "1", "1.0.0" or
 * "1.x" as equal to "1.0", and the spec says a value outside the grammar is
 * handled like a newer one, not silently accepted.
 */
export const compareDeclaredProtocol = (
  declared: string,
  spoken: string,
): "newer" | "not-newer" | "uninterpretable" => {
  if (!/^\d+\.\d+$/.test(declared)) return "uninterpretable";
  return compareVersions(declared, spoken) > 0 ? "newer" : "not-newer";
};

const warnOnProducerDeclaration = (event: unknown): void => {
  const declared = (event as { protocolVersion?: string }).protocolVersion;
  if (declared === undefined || declared === PROTOCOL_VERSION) return;
  switch (compareDeclaredProtocol(declared, PROTOCOL_VERSION)) {
    case "uninterpretable":
      console.warn(
        `[ag-ui] The producer declared protocol version '${declared}', which this client cannot interpret.`,
      );
      return;
    case "newer":
      console.warn(
        `[ag-ui] The producer speaks protocol ${declared}; this client speaks ${PROTOCOL_VERSION}. Unrecognised material will be stripped with warnings.`,
      );
      return;
    case "not-newer":
      return;
  }
};

/**
 * The `forwardedProps` key that carries the server history cursor: the id of
 * the last message the server has confirmed. A forwardedProps key rather than
 * a new RunAgentInput field, because outgoing enforcement strips fields the
 * 1.0 schema does not know.
 */
export const HISTORY_CURSOR_KEY = "ag-ui:historyCursor";

/**
 * The RUN_ERROR code a server-history agent sends when it does not know the
 * thread or the cursor. The client answers it by retrying once with the full
 * history.
 */
export const HISTORY_UNAVAILABLE_CODE = "HISTORY_UNAVAILABLE";

/**
 * Producer-created roles never used as the history cursor. Activity is client
 * display state, and reasoning ids are often not stable between the streamed
 * events and what a backend stores, so a cursor naming one would miss on the
 * server and force a full resend every run.
 */
const NON_CURSOR_ROLES = new Set<Message["role"]>(["activity", "reasoning"]);

/**
 * Client-sent roles a server keeps under the recommended trust rules. A
 * client-authored assistant, system or developer message is dropped by such a
 * server, so it is confirmed but never used as the cursor.
 */
const CLIENT_CURSOR_ROLES = new Set<Message["role"]>(["user", "tool"]);

/** Deletes a null `subagentRunId` in place: absent is its only wire spelling. */
const stripNullAttribution = (messages: Message[]): void => {
  for (const message of messages) {
    if ((message as { subagentRunId?: string | null }).subagentRunId === null) {
      delete (message as { subagentRunId?: string | null }).subagentRunId;
    }
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const advertisesServerManagedHistory = (capabilities: AgentCapabilities | undefined): boolean => {
  const state = capabilities?.state as { serverManagedHistory?: unknown } | undefined;
  return (
    state?.serverManagedHistory === true || capabilities?.custom?.serverManagedHistory === true
  );
};

export interface RunAgentResult {
  // DEFERRED (PNI-272): tightening this to `unknown` is a breaking change for
  // consumers of a published package, not a lint repair. Left for a deliberate
  // API decision.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  newMessages: Message[];
}

export abstract class AbstractAgent {
  public agentId?: string;
  public description: string;
  public threadId: string;
  public messages: Message[];
  public state: State;
  private _debug: ResolvedAgentDebugConfig;
  private _debugLogger: DebugLogger | undefined;
  private _messageFilter?: MessageFilter;
  private _historyMode: HistoryMode = "full";
  /** Cached result of the "auto" capability lookup; unset until one succeeds. */
  private _serverHistoryAdvertised?: boolean;
  private _serverHistoryLookup?: Promise<boolean>;
  /**
   * Ids of messages the server has confirmed, mapped to whether the id may be
   * used as the history cursor, and the thread they belong to. Tracked in
   * every mode, so switching to server history mode later starts from what the
   * server already has.
   */
  private _confirmedMessages = new Map<string, boolean>();
  private _confirmedThreadId?: string;
  public subscribers: AgentSubscriber[] = [];
  public isRunning: boolean = false;
  /** Interrupts emitted by the most recent run that have not yet been resolved.
   *  Populated when RUN_FINISHED arrives with outcome.type === "interrupt".
   *  Cleared when a subsequent run completes successfully. */
  public pendingInterrupts: Interrupt[] = [];
  private middlewares: Middleware[] = [];
  // Emits to immediately detach from the active run (stop processing its stream)
  private activeRunDetach$?: Subject<void>;
  private activeRunCompletionPromise?: Promise<void>;

  /** Stops a legacy override that forwards to this.maxProtocolVersion. */
  private resolvingPeerCeiling = false;

  private resolvePeerCeiling(name: "maxVersion" | "maxProtocolVersion"): string {
    if (this.resolvingPeerCeiling) {
      return packageJson.version;
    }

    // Inspect descriptors without executing either public getter.
    let legacyOverride = Object.getOwnPropertyDescriptor(this, "maxVersion");
    let modernOverride = Object.getOwnPropertyDescriptor(this, "maxProtocolVersion");
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== AbstractAgent.prototype) {
      legacyOverride ??= Object.getOwnPropertyDescriptor(proto, "maxVersion");
      modernOverride ??= Object.getOwnPropertyDescriptor(proto, "maxProtocolVersion");
      proto = Object.getPrototypeOf(proto);
    }

    // With a legacy override, this base getter is reached via super.maxVersion.
    // Return the base ceiling instead of entering that override a second time.
    if (name === "maxVersion" && legacyOverride) {
      return packageJson.version;
    }
    const override = name === "maxProtocolVersion" ? legacyOverride : modernOverride;
    if (!override) {
      return packageJson.version;
    }

    this.resolvingPeerCeiling = true;
    try {
      return override.get ? override.get.call(this) : override.value;
    } finally {
      this.resolvingPeerCeiling = false;
    }
  }

  get maxProtocolVersion(): string {
    return this.resolvePeerCeiling("maxProtocolVersion");
  }

  /**
   * @deprecated Use {@link maxProtocolVersion}. Same value, honest name: this
   * is the ceiling the PEER speaks, not which protocol this SDK implements —
   * that is the generated PROTOCOL_VERSION constant. Registered in the client
   * package's DEPRECATIONS.md; removal no earlier than 2.0.
   */
  get maxVersion(): string {
    if (!this.resolvingPeerCeiling && !warnedDeprecatedMaxVersion) {
      warnedDeprecatedMaxVersion = true;
      console.warn(
        "[ag-ui] AbstractAgent.maxVersion is deprecated — use maxProtocolVersion. Same value; the new name says whose version it is and that it is a ceiling.",
      );
    }
    return this.resolvePeerCeiling("maxVersion");
  }

  get debug(): ResolvedAgentDebugConfig {
    return this._debug;
  }

  set debug(value: AgentDebugConfig | ResolvedAgentDebugConfig) {
    this._debug = resolveAgentDebugConfig(value as AgentDebugConfig);
    this._debugLogger = createDebugLogger(this._debug);
  }

  get debugLogger(): DebugLogger | undefined {
    return this._debugLogger;
  }

  set debugLogger(value: DebugLogger | boolean | undefined) {
    if (typeof value === "boolean") {
      this._debugLogger = value ? createDebugLogger(resolveAgentDebugConfig(true)) : undefined;
    } else {
      this._debugLogger = value;
    }
  }

  /**
   * The peer ceiling as the constructor's version gates need it: a string
   * compareVersions can actually read. A subclass getter is the only writer,
   * and it can answer with something unusable — most often `undefined`,
   * because class fields initialise after `super()` returns — so the value is
   * judged here rather than deep inside the comparison.
   */
  private resolvedCeilingDuringConstruction(): string {
    const ceiling: unknown = this.maxProtocolVersion;
    if (typeof ceiling !== "string" || !validateVersion(ceiling)) {
      throw new AGUIError(
        `maxProtocolVersion resolved to ${JSON.stringify(ceiling)} during construction, which is not a version this client can compare. A ceiling read from an instance field is not available yet — return a literal from the getter.`,
      );
    }
    return ceiling;
  }

  constructor({
    agentId,
    description,
    threadId,
    initialMessages,
    initialState,
    debug,
    messageFilter,
    historyMode,
  }: AgentConfig = {}) {
    this.agentId = agentId;
    this.description = description ?? "";
    this.threadId = threadId ?? uuidv4();
    this.messages = structuredClone_(initialMessages ?? []);
    this.state = structuredClone_(initialState ?? {});
    this._debug = resolveAgentDebugConfig(debug);
    this._debugLogger = createDebugLogger(this._debug);
    this._messageFilter = messageFilter;
    this._historyMode = historyMode ?? "full";

    // Resolved ONCE, and checked before it is compared. A subclass ceiling is
    // read through a getter, and this constructor runs before the subclass's
    // instance fields exist — so `get maxProtocolVersion() { return this.pin }`
    // hands back `undefined` here and compareVersions threw "Invalid argument
    // expected string", which named neither the getter nor the field.
    const peerCeiling = this.resolvedCeilingDuringConstruction();

    if (compareVersions(peerCeiling, "0.0.39") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_39());
    }

    // Auto-insert BackwardCompatibility_0_0_45 for backward compatibility with
    // the retired THINKING_* events. Registered in the repo-root
    // DEPRECATIONS.md (not this package's own, which tracks a different set
    // under a different schema) with an expiry of 2027-09-17, not removed in
    // 1.0 — see also the note on
    // CompatibilityBoundary, which translates the same shapes innermost and so
    // usually gets to them first.
    if (compareVersions(peerCeiling, "0.0.45") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_45());
    }

    // Auto-insert BackwardCompatibility_0_0_57 for backward compatibility with
    // pre-subagent agents: strips subagentRunId and drops SUBAGENT_* lifecycle events.
    if (compareVersions(peerCeiling, "0.0.57") <= 0) {
      this.middlewares.unshift(new BackwardCompatibility_0_0_57());
    }
  }

  public subscribe(subscriber: AgentSubscriber) {
    this.subscribers.push(subscriber);
    return {
      unsubscribe: () => {
        this.subscribers = this.subscribers.filter((s) => s !== subscriber);
      },
    };
  }

  abstract run(input: RunAgentInput): Observable<BaseEvent>;

  /**
   * Returns the agent's current capabilities.
   * Optional — subclasses implement this to advertise what they support.
   */
  getCapabilities?(): Promise<AgentCapabilities>;

  public use(...middlewares: (Middleware | MiddlewareFunction)[]): this {
    const normalizedMiddlewares = middlewares.map((middleware) =>
      typeof middleware === "function" ? new FunctionMiddleware(middleware) : middleware,
    );
    this.middlewares.push(...normalizedMiddlewares);
    return this;
  }

  public async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    try {
      this.isRunning = true;
      this.agentId = this.agentId ?? uuidv4();
      // Only "auto" mode with no cached answer waits here, so every other mode
      // prepares its input synchronously, exactly as before.
      if (this.needsHistoryModeLookup()) {
        await this.resolveHistoryMode();
      }
      const input = this.prepareRunAgentInput(parameters);

      this.debugLogger?.lifecycle("LIFECYCLE", "Run started:", {
        agentId: this.agentId,
        threadId: this.threadId,
      });

      let result: unknown = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));
      const confirmation = this.historyConfirmation(input);

      const subscribers: AgentSubscriber[] = [
        {
          onRunStartedEvent: ({ event }) => warnOnProducerDeclaration(event),
          onRunFinishedEvent: (params) => {
            confirmation.onRunFinished(params.messages);
            if (params.outcome === "success") {
              result = params.result;
            }
          },
        },
        ...this.subscribers,
        subscriber ?? {},
      ];

      runInputs.add(input);
      await this.onInitialize(input, subscribers);

      // Per-run detachment signal + completion promise
      this.activeRunDetach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      this.activeRunCompletionPromise = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });

      const pipeline = pipe(
        () => {
          // Build middleware chain using reduceRight so middlewares can intercept runs.
          // The always-on inbound compatibility boundary runs innermost —
          // closest to the wire — so every other middleware and the
          // enforcement stage see 1.0-shaped events. Appended per run and
          // never stored, so it is installed exactly once regardless of
          // use() or clone().
          const chainedAgent = [...this.middlewares, new CompatibilityBoundary()].reduceRight(
            (nextAgent: AbstractAgent, middleware) =>
              ({
                run: (i: RunAgentInput) => middleware.run(i, nextAgent),
                get messages() {
                  return nextAgent.messages;
                },
                get state() {
                  return nextAgent.state;
                },
              }) as AbstractAgent,
            this, // Original agent is the final 'next'
          );

          return this.runWithHistoryFallback(input, (i) => chainedAgent.run(i));
        },
        // Enforcement BEFORE expansion: a chunk is an event of its own, so it
        // is validated as one like any other, and expansion then only ever
        // reshapes values already known good. Expanding first handed this stage
        // repaired input — a malformed role arrived as "assistant" — so the
        // same defect was fatal when a producer sent it plainly and invisible
        // when it sent it as a chunk. Verification stays after expansion,
        // because what it checks (messages opening and closing, pairing) only
        // exists once the chunk has become a start and a content event.
        enforceEvents(this.debugLogger),
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached. Events that
        // get past this point are the run's, so history confirmation sees them.
        (source$) =>
          source$.pipe(
            takeUntil(this.activeRunDetach$!),
            tap((event) => confirmation.observe(event)),
          ),
        (source$) => this.applyBeforeSourceError(input, source$, subscribers),
        catchError((error) => {
          this.debugLogger?.lifecycle("LIFECYCLE", "Run errored:", {
            agentId: this.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.isRunning = false;
          return this.onError(input, error, subscribers);
        }),
        finalize(() => {
          this.debugLogger?.lifecycle("LIFECYCLE", "Run finished:", {
            agentId: this.agentId,
            threadId: this.threadId,
          });
          this.isRunning = false;
          void this.onFinalize(input, subscribers);
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
          this.activeRunCompletionPromise = undefined;
          this.activeRunDetach$ = undefined;
        }),
      );

      await lastValueFrom(pipeline(of(null)));
      const newMessages = structuredClone_(this.messages).filter(
        (message: Message) => !currentMessageIds.has(message.id),
      );
      return { result, newMessages };
    } finally {
      this.isRunning = false;
    }
  }

  // `input` is part of the published signature: renaming it to `_input` changes
  // the emitted .d.ts that consumers see, so the directive goes here instead.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    throw new AGUIConnectNotImplementedError();
  }
  public async connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    try {
      this.isRunning = true;
      this.agentId = this.agentId ?? uuidv4();
      if (this.needsHistoryModeLookup()) {
        await this.resolveHistoryMode();
      }
      const input = this.prepareRunAgentInput(parameters);
      let result: unknown = undefined;
      const currentMessageIds = new Set(this.messages.map((message) => message.id));
      const confirmation = this.historyConfirmation(input);

      const subscribers: AgentSubscriber[] = [
        {
          onRunStartedEvent: ({ event }) => warnOnProducerDeclaration(event),
          onRunFinishedEvent: (params) => {
            confirmation.onRunFinished(params.messages);
            if (params.outcome === "success") {
              result = params.result;
            }
          },
        },
        ...this.subscribers,
        subscriber ?? {},
      ];

      await this.onInitialize(input, subscribers);

      // Per-run detachment signal + completion promise
      this.activeRunDetach$ = new Subject<void>();
      let resolveActiveRunCompletion: (() => void) | undefined;
      this.activeRunCompletionPromise = new Promise<void>((resolve) => {
        resolveActiveRunCompletion = resolve;
      });

      const pipeline = pipe(
        () => this.runWithHistoryFallback(input, (i) => defer(() => this.connect(i))),
        // The connect flow has no middleware chain, so the always-on inbound
        // boundary applies as a plain operator here (composed with enforcement:
        // rxjs pipe() runs out of typed arities beyond nine stages).
        (source$: Observable<BaseEvent>) =>
          enforceEvents(this.debugLogger)(compatibilityBoundaryOperator()(source$)),
        transformChunks(this.debugLogger),
        verifyEvents(this.debugLogger),
        // Stop processing immediately when this run is detached. Events that
        // get past this point are the run's, so history confirmation sees them.
        (source$) =>
          source$.pipe(
            takeUntil(this.activeRunDetach$!),
            tap((event) => confirmation.observe(event)),
          ),
        (source$) => this.applyBeforeSourceError(input, source$, subscribers),
        catchError((error) => {
          this.isRunning = false;
          if (!(error instanceof AGUIConnectNotImplementedError)) {
            return this.onError(input, error, subscribers);
          }
          return EMPTY;
        }),
        finalize(() => {
          this.isRunning = false;
          void this.onFinalize(input, subscribers);
          resolveActiveRunCompletion?.();
          resolveActiveRunCompletion = undefined;
          this.activeRunCompletionPromise = undefined;
          this.activeRunDetach$ = undefined;
        }),
      );

      // defaultValue prevents EmptyError when catchError returns EMPTY
      // (e.g. ConnectNotImplementedError path)
      await lastValueFrom(pipeline(of(null)), { defaultValue: undefined });
      const newMessages = structuredClone_(this.messages).filter(
        (message: Message) => !currentMessageIds.has(message.id),
      );
      return { result, newMessages };
    } finally {
      this.isRunning = false;
    }
  }

  public abortRun() {}

  public async detachActiveRun(): Promise<void> {
    if (!this.activeRunDetach$) {
      return;
    }
    const completion = this.activeRunCompletionPromise ?? Promise.resolve();
    this.activeRunDetach$.next();
    this.activeRunDetach$?.complete();
    await completion;
  }

  /**
   * Runs apply and processApplyEvents so that every event received before the
   * source errors is fully applied first. The error is held back as a
   * completion, then rethrown unchanged once both stages have drained.
   */
  private applyBeforeSourceError(
    input: RunAgentInput,
    source$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return defer(() => {
      let sourceError: { error: unknown } | undefined;
      const events$ = source$.pipe(
        catchError((error: unknown) => {
          sourceError = { error };
          return EMPTY;
        }),
      );
      const applied$ = this.processApplyEvents(
        input,
        this.apply(input, events$, subscribers),
        subscribers,
      );
      return applied$.pipe(
        concatWith(
          defer(() => {
            const pending = sourceError;
            return pending ? throwError(() => pending.error) : EMPTY;
          }),
        ),
      );
    });
  }

  protected apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return defaultApplyEvents(input, events$, this, subscribers, this.debugLogger);
  }

  protected processApplyEvents(
    input: RunAgentInput,
    events$: Observable<AgentStateMutation>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return events$.pipe(
      tap((event) => {
        if (event.messages) {
          this.messages = event.messages;
          subscribers.forEach((subscriber) => {
            subscriber.onMessagesChanged?.({
              messages: this.messages,
              state: this.state,
              agent: this,
              input,
            });
          });
        }
        // `!== undefined`, not truthiness: State is any JSON value, so a
        // snapshot of `null`, `0`, `""` or `false` is a replacement like any
        // other. The mutation channel only carries `state` when a stage
        // actually set it, so presence is the signal — a truthiness check
        // silently discarded every falsy replacement.
        if (event.state !== undefined) {
          this.state = event.state;
          subscribers.forEach((subscriber) => {
            subscriber.onStateChanged?.({
              state: this.state,
              messages: this.messages,
              agent: this,
              input,
            });
          });
        }
      }),
    );
  }

  /** The configured history mode. See {@link HistoryMode}. */
  get historyMode(): HistoryMode {
    return this._historyMode;
  }

  set historyMode(mode: HistoryMode) {
    this._historyMode = mode;
    this._serverHistoryAdvertised = undefined;
    this._serverHistoryLookup = undefined;
  }

  /**
   * Whether runs upload only unconfirmed messages plus the history cursor. In
   * "auto" mode this reports the cached capability lookup, which runAgent()
   * and connectAgent() perform before preparing their input; until a lookup
   * has succeeded it is false.
   */
  get usesServerHistory(): boolean {
    return (
      this._historyMode === "server" ||
      (this._historyMode === "auto" && this._serverHistoryAdvertised === true)
    );
  }

  /**
   * Forgets which messages the server has confirmed. The next server-history
   * run then uploads the full history without a cursor.
   */
  public resetConfirmedHistory(): void {
    this._confirmedMessages = new Map();
    this._confirmedThreadId = this.threadId;
  }

  private needsHistoryModeLookup(): boolean {
    return this._historyMode === "auto" && this._serverHistoryAdvertised === undefined;
  }

  /**
   * Resolves "auto" mode by asking getCapabilities() once. A successful answer
   * is cached for the agent's lifetime (and shared by concurrent runs); a
   * failed lookup sends this run with full history and is retried on the next
   * run, so a transient failure does not pin full uploads forever. Runs wait
   * for the lookup, so getCapabilities() should bound its own latency.
   */
  private async resolveHistoryMode(): Promise<void> {
    const getCapabilities = this.getCapabilities;
    if (!getCapabilities) {
      // Not cached: getCapabilities may still be assigned after construction.
      return;
    }
    const lookup = (this._serverHistoryLookup ??= Promise.resolve()
      .then(() => getCapabilities.call(this))
      .then(advertisesServerManagedHistory));
    try {
      const advertised = await lookup;
      // Reassigning historyMode while this lookup was in flight discarded it.
      if (this._serverHistoryLookup === lookup) {
        this._serverHistoryAdvertised = advertised;
      }
    } catch (error) {
      if (this._serverHistoryLookup === lookup) {
        this._serverHistoryLookup = undefined;
      }
      this.debugLogger?.lifecycle("LIFECYCLE", "Capability lookup failed, sending full history:", {
        agentId: this.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The confirmations for `threadId`, dropping any recorded for another thread. */
  private confirmedMessagesFor(threadId: string): Map<string, boolean> {
    if (this._confirmedThreadId !== threadId) {
      this._confirmedMessages = new Map();
      this._confirmedThreadId = threadId;
    }
    return this._confirmedMessages;
  }

  /**
   * Tracks which messages one run's server has confirmed.
   *
   * A RUN_FINISHED confirms exactly the messages the run's input carried plus
   * the messages the run's events produced. Anything else in the agent at that
   * point stays unconfirmed and is uploaded next run: a message a messageFilter
   * withheld, client-only activity, a message the application added while the
   * run streamed, or one a subscriber mutation inserted. Every message in a
   * MESSAGES_SNAPSHOT is confirmed, since the server sent it.
   *
   * Cursor eligibility: a producer message (produced by the run's events or
   * delivered in a snapshot) qualifies unless it is activity or reasoning; a
   * message the client sent qualifies only as `user` or `tool`, the roles a
   * server keeps under the recommended trust rules.
   */
  private historyConfirmation(input: RunAgentInput) {
    // Ids the run's events created a message under. TOOL_CALL_START names its
    // parent message, or the reducer falls back to the tool call id. An id the
    // agent already held when the first event arrived (a client-authored
    // parent, say) was not created by the run.
    const producedIds = new Set<string>();
    let preRunIds: Set<string> | undefined;
    const produced = (id: unknown) => {
      if (typeof id === "string" && !preRunIds?.has(id)) producedIds.add(id);
    };
    const confirm = (id: string, eligible: boolean) => {
      const confirmed = this.confirmedMessagesFor(input.threadId);
      confirmed.set(id, confirmed.get(id) === true || eligible);
    };
    return {
      observe: (event: BaseEvent) => {
        // Observed before the event is applied, so on the first event the
        // agent still holds exactly what it held when the run began.
        preRunIds ??= new Set(this.messages.map((message) => message.id));
        if (event.type === EventType.MESSAGES_SNAPSHOT) {
          for (const { id, role } of (event as MessagesSnapshotEvent).messages) {
            confirm(id, !NON_CURSOR_ROLES.has(role));
          }
          return;
        }
        const { messageId, parentMessageId, toolCallId } = event as {
          messageId?: unknown;
          parentMessageId?: unknown;
          toolCallId?: unknown;
        };
        produced(messageId);
        if (event.type === EventType.TOOL_CALL_START) {
          produced(parentMessageId);
          produced(toolCallId);
        }
      },
      onRunFinished: (messages: ReadonlyArray<Readonly<Message>>) => {
        const sentIds = new Set(
          (Array.isArray(input.messages) ? input.messages : []).map((message) => message.id),
        );
        for (const { id, role } of messages) {
          if (sentIds.has(id)) {
            confirm(id, CLIENT_CURSOR_ROLES.has(role));
          } else if (producedIds.has(id)) {
            confirm(id, !NON_CURSOR_ROLES.has(role));
          }
        }
      },
    };
  }

  /**
   * Builds the messages and forwardedProps a run uploads. The order is fixed:
   * activity messages are dropped first, then (in server history mode) the
   * messages the server has confirmed, and messageFilter runs last on what is
   * left. In server history mode the cursor is written to
   * `forwardedProps["ag-ui:historyCursor"]`, or removed when nothing usable is
   * confirmed, in which case the full history is sent. Never mutates
   * `messages`; `forwardedProps` is copied before the cursor is written.
   */
  private outgoingHistory(
    messages: Message[],
    forwardedProps: RunAgentInput["forwardedProps"],
  ): { messages: Message[]; forwardedProps: RunAgentInput["forwardedProps"] } {
    let outgoing = messages.filter((message) => message.role !== "activity");
    let props = forwardedProps;

    if (this.usesServerHistory) {
      if (isPlainObject(props)) {
        const confirmed = this.confirmedMessagesFor(this.threadId);
        let cursor: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i];
          if (confirmed.get(message.id) === true) {
            cursor = message.id;
            break;
          }
        }
        props = { ...props };
        if (cursor !== undefined) {
          outgoing = outgoing.filter((message) => !confirmed.has(message.id));
          props[HISTORY_CURSOR_KEY] = cursor;
        } else {
          delete props[HISTORY_CURSOR_KEY];
        }
      } else {
        // The cursor can only travel in an object; without one the server
        // could not place a delta, so this run carries the full history.
        this.debugLogger?.lifecycle(
          "LIFECYCLE",
          "forwardedProps is not an object, sending full history:",
          { agentId: this.agentId },
        );
      }
    }

    return {
      messages: this._messageFilter ? this._messageFilter(outgoing) : outgoing,
      forwardedProps: props,
    };
  }

  /**
   * Runs one attempt and, when the server answers a delta upload with
   * RUN_ERROR `HISTORY_UNAVAILABLE`, retries exactly once with the full
   * history and no cursor.
   *
   * The retry looks like one run to subscribers. The first attempt's
   * RUN_STARTED passes through at once (nothing is delayed); its refusal is
   * dropped, and so is the retry's own leading RUN_STARTED, so the retry's
   * events continue the run that already started. `input` is updated in place
   * to what the retry sent, and the retry reuses its runId. Only a refusal
   * that is the first event, or follows the RUN_STARTED directly, is retried;
   * a later HISTORY_UNAVAILABLE (after the run produced output) and a refusal
   * of the retry itself reach subscribers as an ordinary RUN_ERROR.
   */
  private runWithHistoryFallback(
    input: RunAgentInput,
    run: (input: RunAgentInput) => Observable<BaseEvent>,
  ): Observable<BaseEvent> {
    const sentDelta =
      this.usesServerHistory &&
      isPlainObject(input.forwardedProps) &&
      input.forwardedProps[HISTORY_CURSOR_KEY] !== undefined;
    if (!sentDelta) {
      return run(input);
    }

    return new Observable<BaseEvent>((subscriber) => {
      // Owns the first attempt. add() on an already closed Subscription
      // unsubscribes what it is given, so a source that refuses synchronously,
      // inside its own subscribe(), is still torn down.
      const firstAttempt = new Subscription();
      let retry: Subscription | undefined;
      let abandoned = false;
      let probing = true;
      let runStartedSent = false;

      const startRetry = () => {
        this.resetConfirmedHistory();
        const messages = structuredClone_(this.messages) as Message[];
        stripNullAttribution(messages);
        const outgoing = this.outgoingHistory(messages, input.forwardedProps);
        input.messages = outgoing.messages;
        input.forwardedProps = outgoing.forwardedProps;
        this.debugLogger?.lifecycle("LIFECYCLE", "History unavailable, retrying with full history:", {
          agentId: this.agentId,
          threadId: input.threadId,
        });
        let first = true;
        retry = defer(() => run(input))
          .pipe(
            filter((event) => {
              const duplicateStart =
                first && runStartedSent && event.type === EventType.RUN_STARTED;
              first = false;
              return !duplicateStart;
            }),
          )
          .subscribe(subscriber);
      };

      const attempt = run(input).subscribe({
        next: (event) => {
          if (abandoned) return;
          if (probing) {
            if (event.type === EventType.RUN_STARTED && !runStartedSent) {
              runStartedSent = true;
              subscriber.next(event);
              return;
            }
            probing = false;
            if (
              event.type === EventType.RUN_ERROR &&
              (event as RunErrorEvent).code === HISTORY_UNAVAILABLE_CODE
            ) {
              abandoned = true;
              firstAttempt.unsubscribe();
              startRetry();
              return;
            }
          }
          subscriber.next(event);
        },
        error: (error) => {
          if (!abandoned) subscriber.error(error);
        },
        complete: () => {
          if (!abandoned) subscriber.complete();
        },
      });
      firstAttempt.add(attempt);

      return () => {
        firstAttempt.unsubscribe();
        retry?.unsubscribe();
      };
    });
  }

  protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
    const clonedMessages = structuredClone_(this.messages) as Message[];
    // Egress chokepoint for the no-null rule on attribution (PNI-199 alignment):
    // the verifier and reducer keep event-derived state clean, but messages also
    // enter through the constructor's initialMessages and subscriber mutations,
    // neither of which is schema-checked. A null tag must never be serialized
    // onto the wire — the schemas forbid it, so a receiving agent would reject
    // the whole run. Absent is the only spelling.
    stripNullAttribution(clonedMessages);
    const outgoing = this.outgoingHistory(
      clonedMessages,
      structuredClone_(parameters?.forwardedProps ?? {}),
    );

    return {
      threadId: this.threadId,
      runId: parameters?.runId || uuidv4(),
      // Declared only when the peer's ceiling is not pinned below this
      // client: a downgraded peer predates the field, and an unknown input
      // member is exactly what a strict old parser could reject.
      ...(compareVersions(this.maxProtocolVersion, packageJson.version) >= 0 && {
        protocolVersion: PROTOCOL_VERSION,
      }),
      tools: structuredClone_(parameters?.tools ?? []),
      context: structuredClone_(parameters?.context ?? []),
      forwardedProps: outgoing.forwardedProps,
      state: structuredClone_(this.state),
      messages: outgoing.messages,
      ...(parameters?.resume !== undefined ? { resume: structuredClone_(parameters.resume) } : {}),
    };
  }

  protected async onInitialize(input: RunAgentInput, subscribers: AgentSubscriber[]) {
    if (runInputs.has(input) && this.pendingInterrupts.length > 0) {
      const resumeIds = new Set((input.resume ?? []).map((r) => r.interruptId));
      const uncovered = this.pendingInterrupts.map((i) => i.id).filter((id) => !resumeIds.has(id));
      if (uncovered.length > 0) {
        throw new AGUIError(
          `Thread has ${uncovered.length} pending interrupt(s) not addressed by resume: ${uncovered.join(", ")}`,
        );
      }
      for (const i of this.pendingInterrupts) {
        if (!isInterruptExpired(i)) continue;
        // Expiry forecloses ANSWERING, not resolving the thread: a cancelled
        // entry is the conforming way past an interrupt nobody answered in
        // time. Throwing on mere presence — which this once did — made an
        // expired interrupt block its thread forever, since coverage is
        // mandatory and no entry could ever satisfy this check.
        const entry = (input.resume ?? []).find((r) => r.interruptId === i.id);
        if (entry?.status !== "cancelled") {
          throw new AGUIError(
            `Interrupt ${i.id} expired at ${i.expiresAt} and can no longer be answered. Cancel it to continue the thread.`,
          );
        }
      }
    }

    const onRunInitializedMutation = await runSubscribersWithMutation(
      subscribers,
      this.messages,
      this.state,
      (subscriber, messages, state) =>
        subscriber.onRunInitialized?.({ messages, state, agent: this, input }),
    );
    if (
      onRunInitializedMutation.messages !== undefined ||
      onRunInitializedMutation.state !== undefined
    ) {
      if (onRunInitializedMutation.messages) {
        this.messages = onRunInitializedMutation.messages;
        // This assignment lands AFTER prepareRunAgentInput sanitized the input,
        // so the no-null rule must be re-applied here — a subscriber mutation is
        // the one writer that can still put a null tag on the wire.
        stripNullAttribution(onRunInitializedMutation.messages);
        // The activity filter from prepareRunAgentInput has to be re-applied
        // for the same reason the null-tag sanitisation above does: this
        // assignment lands AFTER that filter ran, and a subscriber replacing
        // the message list is the one writer that can still put an activity
        // message — the consumer's own display state, which no producer owns —
        // onto the wire. The AGENT keeps it; only the input copy is filtered.
        // The server history delta and messageFilter are re-applied with it,
        // in the same order prepareRunAgentInput uses.
        const outgoing = this.outgoingHistory(
          onRunInitializedMutation.messages,
          input.forwardedProps,
        );
        input.messages = outgoing.messages;
        input.forwardedProps = outgoing.forwardedProps;
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      // `!== undefined`, as in apply(): a subscriber may legitimately set a
      // falsy state, and the mutation only carries the key when it did.
      if (onRunInitializedMutation.state !== undefined) {
        this.state = onRunInitializedMutation.state;
        input.state = onRunInitializedMutation.state;
        subscribers.forEach((subscriber) => {
          subscriber.onStateChanged?.({
            state: this.state,
            messages: this.messages,
            agent: this,
            input,
          });
        });
      }
    }
  }

  protected onError(input: RunAgentInput, error: Error, subscribers: AgentSubscriber[]) {
    return from(
      runSubscribersWithMutation(
        subscribers,
        this.messages,
        this.state,
        (subscriber, messages, state) =>
          subscriber.onRunFailed?.({ error, messages, state, agent: this, input }),
      ),
    ).pipe(
      map((onRunFailedMutation) => {
        const mutation = onRunFailedMutation as AgentStateMutation;
        if (mutation.messages !== undefined || mutation.state !== undefined) {
          if (mutation.messages !== undefined) {
            this.messages = mutation.messages;
            subscribers.forEach((subscriber) => {
              subscriber.onMessagesChanged?.({
                messages: this.messages,
                state: this.state,
                agent: this,
                input,
              });
            });
          }
          if (mutation.state !== undefined) {
            this.state = mutation.state;
            subscribers.forEach((subscriber) => {
              subscriber.onStateChanged?.({
                state: this.state,
                messages: this.messages,
                agent: this,
                input,
              });
            });
          }
        }

        if (mutation.stopPropagation !== true) {
          // Silently ignore abort errors (e.g. from navigation during active requests).
          // AbortController.abort(reason) can produce:
          //   - A DOMException with name "AbortError"
          //   - The reason value itself as a plain string (e.g. "component unmounted")
          const errStr = String(error);
          const isAbort =
            error.name === "AbortError" ||
            error.message === "Fetch is aborted" ||
            error.message === "signal is aborted without reason" ||
            error.message === "component unmounted" ||
            errStr === "component unmounted";
          if (!isAbort) {
            console.error("Agent execution failed:", error);
            throw error;
          }
        }

        // Return an empty mutation instead of null to prevent EmptyError
        return {} as AgentStateMutation;
      }),
    );
  }

  protected async onFinalize(input: RunAgentInput, subscribers: AgentSubscriber[]) {
    const onRunFinalizedMutation = await runSubscribersWithMutation(
      subscribers,
      this.messages,
      this.state,
      (subscriber, messages, state) =>
        subscriber.onRunFinalized?.({ messages, state, agent: this, input }),
    );

    if (
      onRunFinalizedMutation.messages !== undefined ||
      onRunFinalizedMutation.state !== undefined
    ) {
      if (onRunFinalizedMutation.messages !== undefined) {
        this.messages = onRunFinalizedMutation.messages;
        subscribers.forEach((subscriber) => {
          subscriber.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
            input,
          });
        });
      }
      if (onRunFinalizedMutation.state !== undefined) {
        this.state = onRunFinalizedMutation.state;
        subscribers.forEach((subscriber) => {
          subscriber.onStateChanged?.({
            state: this.state,
            messages: this.messages,
            agent: this,
            input,
          });
        });
      }
    }
  }

  public clone() {
    const cloned = Object.create(Object.getPrototypeOf(this));

    cloned.agentId = this.agentId;
    cloned.description = this.description;
    cloned.threadId = this.threadId;
    cloned.messages = structuredClone_(this.messages);
    cloned.state = structuredClone_(this.state);
    cloned._debug = this._debug;
    cloned._debugLogger = this._debugLogger;
    cloned._messageFilter = this._messageFilter;
    cloned._historyMode = this._historyMode;
    cloned._serverHistoryAdvertised = this._serverHistoryAdvertised;
    cloned._serverHistoryLookup = this._serverHistoryLookup;
    cloned._confirmedMessages = new Map(this._confirmedMessages);
    cloned._confirmedThreadId = this._confirmedThreadId;
    cloned.isRunning = this.isRunning;
    cloned.subscribers = [...this.subscribers];
    cloned.middlewares = [...this.middlewares];
    cloned.pendingInterrupts = structuredClone_(this.pendingInterrupts);

    return cloned;
  }

  public addMessage(message: Message) {
    // Add message to the messages array
    this.messages.push(message);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onNewMessage sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onNewMessage?.({
          message,
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }

      // Fire onNewToolCall if the message is from assistant and contains tool calls
      if (message.role === "assistant" && message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          for (const subscriber of this.subscribers) {
            await subscriber.onNewToolCall?.({
              toolCall,
              messages: this.messages,
              state: this.state,
              agent: this,
            });
          }
        }
      }

      // Fire onMessagesChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public addMessages(messages: Message[]) {
    // Add all messages to the messages array
    this.messages.push(...messages);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onNewMessage and onNewToolCall for each message sequentially
      for (const message of messages) {
        // Fire onNewMessage sequentially
        for (const subscriber of this.subscribers) {
          await subscriber.onNewMessage?.({
            message,
            messages: this.messages,
            state: this.state,
            agent: this,
          });
        }

        // Fire onNewToolCall if the message is from assistant and contains tool calls
        if (message.role === "assistant" && message.toolCalls) {
          for (const toolCall of message.toolCalls) {
            for (const subscriber of this.subscribers) {
              await subscriber.onNewToolCall?.({
                toolCall,
                messages: this.messages,
                state: this.state,
                agent: this,
              });
            }
          }
        }
      }

      // Fire onMessagesChanged once at the end sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public setMessages(messages: Message[]) {
    // Replace the entire messages array
    this.messages = structuredClone_(messages);
    // A replaced history (a load, a rewind, an edit) may no longer match what
    // the server stored, so the next server-history run starts over with the
    // full history and no cursor, and the server decides how to reconcile it.
    this.resetConfirmedHistory();

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onMessagesChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onMessagesChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public setState(state: State) {
    // Replace the entire state
    this.state = structuredClone_(state);

    // Notify subscribers sequentially in the background
    (async () => {
      // Fire onStateChanged sequentially
      for (const subscriber of this.subscribers) {
        await subscriber.onStateChanged?.({
          messages: this.messages,
          state: this.state,
          agent: this,
        });
      }
    })();
  }

  public legacy_to_be_removed_runAgentBridged(
    config?: RunAgentParameters,
  ): Observable<LegacyRuntimeProtocolEvent> {
    this.agentId = this.agentId ?? uuidv4();
    const input = this.prepareRunAgentInput(config);

    // Build middleware chain for legacy bridge
    const runObservable = (() => {
      const chainedAgent = [...this.middlewares, new CompatibilityBoundary()].reduceRight(
        (nextAgent: AbstractAgent, middleware) =>
          ({
            run: (i: RunAgentInput) => middleware.run(i, nextAgent),
            get messages() {
              return nextAgent.messages;
            },
            get state() {
              return nextAgent.state;
            },
          }) as AbstractAgent,
        this,
      );

      return chainedAgent.run(input);
    })();

    return runObservable.pipe(
      enforceEvents(this.debugLogger),
      transformChunks(this.debugLogger),
      verifyEvents(this.debugLogger),
      convertToLegacyEvents(this.threadId, input.runId, this.agentId),
      (events$: Observable<LegacyRuntimeProtocolEvent>) => {
        return events$.pipe(
          map((event) => {
            this.debugLogger?.event("LEGACY", "Event:", event, { type: event.type });
            return event;
          }),
        );
      },
    );
  }
}
