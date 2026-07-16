import { Observable, Subscriber } from "rxjs";
import {
  Client as LangGraphClient,
  EventsStreamEvent,
  StreamMode,
  Config as LangGraphConfig,
  ThreadState,
  Assistant,
  Message as LangGraphMessage,
  Config,
  Interrupt as LangGraphInterrupt,
  Thread,
  ThreadStream,
  SubscriptionHandle,
} from "@langchain/langgraph-sdk";
import { randomUUID } from "@ag-ui/client";
import {
  LangGraphPlatformMessage,
  CustomEventNames,
  LangGraphEventTypes,
  State,
  MessagesInProgressRecord,
  ReasoningInProgress,
  SchemaKeys,
  MessageInProgress,
  RunMetadata,
  PredictStateTool,
  LangGraphReasoning,
  StateEnrichment,
  LangGraphToolWithName,
  V3MessageEvent,
  V3ToolsEvent,
} from "./types";
import {
  AbstractAgent,
  AgentCapabilities,
  AgentConfig,
  AgentSubscriber,
  CustomEvent,
  EventType,
  Interrupt as AGUIInterrupt,
  MessagesSnapshotEvent,
  RawEvent,
  ResumeEntry,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedInterruptOutcome,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
} from "@ag-ui/client";
import {
  langGraphInterruptsToAGUI,
  buildLgCommandResumeFromAgui,
  reconcileLegacyResumeInterrupts,
} from "./interrupts";
import { RunsStreamPayload } from "@langchain/langgraph-sdk/dist/types";
import {
  aguiMessagesToLangChain,
  DEFAULT_SCHEMA_KEYS,
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
  langchainMessagesToAgui,
  resolveMessageContent,
  resolveReasoningContent,
  resolveEncryptedReasoningContent,
} from "@/utils";
import { ToolMessage } from "@langchain/core/messages";
import { isMessageTupleEvent, isSubgraphStreamEvent } from "@/extractors";

type ToolMessageFieldsWithToolCallId = {
  type?: string;
  tool_call_id: string;
  name?: string;
  content: unknown;
  id?: string;
};

export type ProcessedEvents =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ReasoningEncryptedValueEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | RawEvent
  | CustomEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent;

type RunAgentExtendedInput<
  TStreamMode extends StreamMode | StreamMode[] = StreamMode,
  TSubgraphs extends boolean = false,
> = Omit<RunAgentInput, "forwardedProps"> & {
  forwardedProps?: Omit<RunsStreamPayload<TStreamMode, TSubgraphs>, "input"> & {
    nodeName?: string;
    threadMetadata?: Record<string, any>;
    // A2UI tool-injection flag set by the A2UI middleware. Surfaced into
    // ag-ui state so graphs/tools can read it directly.
    injectA2UITool?: boolean | string;
  };
};

interface RegenerateInput extends RunAgentExtendedInput {
  messageCheckpoint: LangGraphMessage;
}

/**
 * Cached per-thread (ThreadStream, custom:agui subscription) pair.
 *
 * The agui subscription is opened once and reused across every run on a
 * given thread, so server-side `record.queuedEvents` replay never lands
 * on a fresh sink. `submitRun`'s `#prepareForNextRun` auto-resumes
 * the sub between runs.
 */
export interface TransformerThreadEntry {
  thread: ThreadStream;
  aguiSub: SubscriptionHandle<any, ProcessedEvents>;
}

/**
 * AI message shape we care about in the sanitizer (the actual SDK type
 * is a discriminated union over message roles).
 */
type AssistantContentBlock = { type?: string; [key: string]: unknown };
type AssistantResponseMetadata = { output_version?: string; [key: string]: unknown };
type AssistantMessageLike = LangGraphMessage & {
  content?: string | AssistantContentBlock[];
  response_metadata?: AssistantResponseMetadata;
};

/**
 * Defensive cleanup for assistant messages being re-sent to the model.
 *
 * Two upstream issues we sidestep:
 *
 *  1. CopilotKit reconstructs assistant messages from TOOL_CALL_* events
 *     and stuffs `tool_call` blocks back into the message `content`
 *     array. langchain 1.4 + OpenAI reject that shape on the wire; the
 *     same data already lives on `tool_calls`, so the blocks are pure
 *     noise. Strip them. If only tool_call blocks remain, collapse
 *     `content` to "" since an empty content array trips other validators.
 *
 *  2. langchain-core's AIMessage v1 path (`response_metadata.output_version
 *     === "v1"`) routes `content` through a `contentBlocks` array that
 *     langchain-openai's Responses serializer mistypes — prior assistant
 *     text blocks come back as `input_text` and OpenAI returns a 400.
 *     Drop the v1 flag from re-sent messages so the legacy content-array
 *     path is used, which the Responses API accepts.
 *
 * Pure function — no side effects, no I/O.
 */
export function sanitizeAssistantMessages(
  payloadInput: { messages?: LangGraphMessage[]; [key: string]: unknown } | null | undefined,
): { messages?: LangGraphMessage[]; [key: string]: unknown } | null | undefined {
  if (!payloadInput || !payloadInput.messages) return payloadInput;
  return {
    ...payloadInput,
    messages: payloadInput.messages.map((raw) => {
      if (raw?.type !== "ai") return raw;
      let next = raw as AssistantMessageLike;
      if (Array.isArray(next.content)) {
        const remaining = next.content.filter(
          (block) => block?.type !== "tool_call",
        );
        if (remaining.length !== next.content.length) {
          next = {
            ...next,
            content: remaining.length === 0 ? "" : remaining,
          };
        }
      }
      const rm = next.response_metadata;
      if (rm && typeof rm === "object" && "output_version" in rm) {
        const { output_version: _ov, ...rest } = rm;
        next = { ...next, response_metadata: rest };
      }
      return next as LangGraphMessage;
    }),
  };
}

export interface LangGraphAgentConfig extends AgentConfig {
  /**
   * Optional pre-constructed LangGraphClient. When provided, the agent uses
   * this client directly and does NOT install its own `onRequest` hook.
   *
   * WARNING: Custom-client users do NOT get per-request header forwarding via
   * `headers` / `headerFactory`. The runtime's `agent.headers` writes will be
   * inert — the custom client is responsible for any header injection.
   * If you need per-request header forwarding, omit this field and let the
   * adapter construct its own client.
   */
  client?: LangGraphClient;
  deploymentUrl: string;
  langsmithApiKey?: string;
  propertyHeaders?: Record<string, string>;
  assistantConfig?: LangGraphConfig;
  agentName?: string;
  graphId: string;
  /**
   * Optional factory that returns per-request headers.
   * Called on every HTTP request to langgraph-api.
   * Use this for dynamic headers that change between requests (e.g., trace IDs).
   * For static headers, use propertyHeaders instead.
   *
   * WARNING: Custom factories must not capture mutable agent state across clones.
   * Each clone gets its own `onRequest` closure; the factory should read from the
   * specific agent instance (e.g., `() => myAgent.headers`), not from a shared
   * variable that could be mutated by a different clone or request.
   */
  headerFactory?: () => Record<string, string>;
  /** Emit legacy CUSTOM(name="on_interrupt") events alongside the terminating
   *  RUN_FINISHED. Default true during the migration window. (The RUN_FINISHED
   *  carries outcome={type:"interrupt"} only when `emitInterruptOutcome` is
   *  enabled — or when this flag is false, which forces the outcome on to avoid
   *  surfacing the interrupt via neither channel.) */
  enableLegacyOnInterruptEvent?: boolean;
  /**
   * Terminate interrupted runs with the AG-UI structured outcome
   * `RUN_FINISHED.outcome={type:"interrupt", interrupts:[...]}`.
   *
   * Default **false**. Opt-in: released clients that drive interrupts through
   * the legacy `forwardedProps.command.resume` channel (e.g. CopilotKit's
   * `useLangGraphInterrupt`, as of v1.60.x) stop sending any resume directive
   * once they observe the structured outcome, which silently strands the run.
   * Until those clients adopt `RunAgentInput.resume[]`, emitting the outcome by
   * default would break them — so it must be explicitly enabled by clients that
   * understand the canonical resume protocol. When false, interrupted runs end
   * with a plain `RUN_FINISHED` (plus the legacy on_interrupt event), exactly as
   * before structured interrupts existed.
   */
  emitInterruptOutcome?: boolean;
}

const ROOT_SUBGRAPH_NAME = "root";

// v3 protocol channels we subscribe to.
// Consumed today:
//   - messages   → text / tool-call args / reasoning (handleSingleEventV3)
//   - values     → local state cache (latestStateValues)
//   - lifecycle  → node/step changes + subgraph / messages-tuple detection
//   - custom     → `agui` passthrough (compiled-in transformer)
// Dropped (were subscribed-but-ignored): `updates` (explicitly skipped),
// `input`, `checkpoints` (never read).
// Still subscribed, translation pending a decision:
//   - tools → live TOOL_CALL_RESULT (today tool output only lands in the
//     end-of-run MESSAGES_SNAPSHOT)
//   - tasks → live interrupts (today interrupts are read from a post-run
//     threads.getState() poll, not this channel)
const DEFAULT_STREAM_MODES = [
    "values",
    "messages",
    "tools",
    "lifecycle",
    "tasks",
    "custom",
]

export class LangGraphAgent extends AbstractAgent {
  client: LangGraphClient;
  assistantConfig?: LangGraphConfig;
  agentName?: string;
  graphId: string;
  /** Per-request headers set by the runtime (e.g., CopilotKit).
   *  Read by the default headerFactory on every outgoing request. */
  public headers: Record<string, string> = {};
  assistant?: Assistant;
  messagesInProcess: MessagesInProgressRecord;
  emittedToolCallStartIds: Set<string> = new Set();
  // Per-run dedup of interrupt ids already surfaced as CUSTOM OnInterrupt.
  // The v3 `tasks` channel re-broadcasts the same interrupt across its
  // create/result frames, and the post-run threads.getState() scan can
  // see it again — both consult this set so the client renders one
  // prompt per interrupt. Reset at the start of each v3 run.
  emittedInterruptIds: Set<string> = new Set();
  reasoningProcess: null | ReasoningInProgress;
  // Canonical reasoning id (e.g. OpenAI `rs_…`) stashed from a text-less id
  // carrier chunk, consumed when the first text delta opens the reasoning
  // message. See handleReasoningEvent.
  private pendingReasoningId?: string;
  activeRun?: RunMetadata;
  // Subgraph node names discovered dynamically from langgraph_checkpoint_ns
  private subgraphs: Set<string> = new Set();
  private currentSubgraph: string = ROOT_SUBGRAPH_NAME;
  // Stop control flags
  private cancelRequested: boolean = false;
  private cancelSent: boolean = false;
  // Guards against double-streaming in the messages-tuple fallback path.
  // Set to true when events-mode (on_chat_model_stream) begins; thereafter
  // handleMessagesTupleEvent is skipped. Appears unused because it is only
  // read inside the fallback branch — removing it would cause duplicate messages
  // on LangGraph Platform deployments that emit both stream modes simultaneously.
  private eventsStreamActive: boolean = false;
  // @ts-expect-error no need to initialize subscriber right now
  subscriber: Subscriber<ProcessedEvents>;
  constantSchemaKeys: string[] = DEFAULT_SCHEMA_KEYS;
  config: LangGraphAgentConfig;
  // Shared-by-reference holder for the one-time v3-protocol detection
  // result. Wrapped in an object (not a bare boolean) so `clone()` can
  // share it by reference — the server's protocol version is global, so
  // every clone targeting the same deployment reuses one probe result.
  private v3Support: { value?: boolean } = {};
  // Per-thread cache of (ThreadStream + custom:agui SubscriptionHandle).
  // Shared across `clone()`s so each request reuses the same connection
  // and the same persistent subscription. Reusing matters because:
  //   - Server replays its per-thread `record.queuedEvents` to ANY new
  //     SSE sink, with no `since` exposed by the SDK. A fresh sub on a
  //     new ThreadStream therefore receives prior runs' events as replays.
  //   - The persistent sub here was attached BEFORE the first run, so it
  //     has nothing to replay; subsequent runs reuse it without
  //     triggering a stream rotation, so no replay occurs.
  // Pause/resume bracket each run: SDK's `submitRun` calls
  // `#prepareForNextRun` which auto-resumes the sub.
  transformerThreads: Map<string, TransformerThreadEntry> = new Map();
  enableLegacyOnInterruptEvent: boolean;
  emitInterruptOutcome: boolean;

  constructor(config: LangGraphAgentConfig) {
    super(config);
    this.config = config;
    this.enableLegacyOnInterruptEvent = config.enableLegacyOnInterruptEvent ?? true;
    this.emitInterruptOutcome = config.emitInterruptOutcome ?? false;
    this.messagesInProcess = {};
    this.agentName = config.agentName;
    this.graphId = config.graphId;
    this.assistantConfig = config.assistantConfig;
    this.reasoningProcess = null;

    // Default factory reads this.headers (set per-clone by CopilotKit Runtime)
    const agent = this;
    const headerFactory = config.headerFactory ?? (() => agent.headers);

    if (config?.client && config.headerFactory) {
      console.debug(
        "[@ag-ui/langgraph] Both `config.client` and `config.headerFactory` were set. " +
          "Custom clients bypass the adapter's onRequest hook — `headerFactory` will not " +
          "be invoked. Either omit `client` to enable adapter-managed header forwarding, " +
          "or wire headers into your custom client directly.",
      );
    }
    this.client =
      config?.client ??
      new LangGraphClient({
        apiUrl: config.deploymentUrl,
        apiKey: config.langsmithApiKey,
        defaultHeaders: { ...(config.propertyHeaders ?? {}) },
        onRequest: (url: URL, init: RequestInit): RequestInit => {
          const dynamicHeaders = headerFactory();
          if (!dynamicHeaders || Object.keys(dynamicHeaders).length === 0) {
            return init;
          }
          return {
            ...init,
            headers: {
              ...(init.headers as Record<string, string>),
              ...dynamicHeaders,
            },
          };
        },
      });
  }

  public clone() {
    const cloned = Object.assign(super.clone(), {
      config: this.config,
      messagesInProcess: structuredClone(this.messagesInProcess),
      agentName: this.agentName,
      graphId: this.graphId,
      assistantConfig: this.assistantConfig,
      reasoningProcess: this.reasoningProcess
        ? structuredClone(this.reasoningProcess)
        : null,
      constantSchemaKeys: [...this.constantSchemaKeys],
      headers: { ...this.headers },
      client: this.client,
      enableLegacyOnInterruptEvent: this.enableLegacyOnInterruptEvent,
      emitInterruptOutcome: this.emitInterruptOutcome,

      assistant: this.assistant,
      activeRun: this.activeRun ? structuredClone(this.activeRun) : undefined,
      cancelRequested: this.cancelRequested,
      cancelSent: this.cancelSent,
      subgraphs: this.subgraphs ? new Set(this.subgraphs) : new Set(),
      currentSubgraph: ROOT_SUBGRAPH_NAME,
      // Share by reference — both caches live across clones.
      v3Support: this.v3Support,
      transformerThreads: this.transformerThreads,
    });

    // Rebuild client so onRequest captures the cloned agent's headers
    if (!this.config.client) {
      const headerFactory = this.config.headerFactory ?? (() => cloned.headers);
      cloned.client = new LangGraphClient({
        apiUrl: this.config.deploymentUrl,
        apiKey: this.config.langsmithApiKey,
        defaultHeaders: { ...(this.config.propertyHeaders ?? {}) },
        onRequest: (url: URL, init: RequestInit): RequestInit => {
          const dynamicHeaders = headerFactory();
          if (!dynamicHeaders || Object.keys(dynamicHeaders).length === 0) {
            return init;
          }
          return {
            ...init,
            headers: {
              ...(init.headers as Record<string, string>),
              ...dynamicHeaders,
            },
          };
        },
      });
    }

    return cloned;
  }

  dispatchEvent(event: ProcessedEvents) {
    this.subscriber.next(event);
    return true;
  }

  private dispatchInterruptFinish(args: {
    threadId: string;
    runId: string;
    lgInterrupts: LangGraphInterrupt[];
  }) {
    const { threadId, runId, lgInterrupts } = args;
    const aguiInterrupts: AGUIInterrupt[] = this.interruptsToAGUI(lgInterrupts);

    if (this.enableLegacyOnInterruptEvent) {
      for (const lg of lgInterrupts) {
        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value:
            typeof lg.value === "string" ? lg.value : JSON.stringify(lg.value),
          rawEvent: lg,
        });
      }
    }

    // Emit the structured outcome when opted in, OR whenever the legacy
    // on_interrupt event is disabled — otherwise the interrupt would be
    // surfaced by neither channel and silently swallowed. By default
    // (legacy on, emitInterruptOutcome off) this is a plain RUN_FINISHED:
    // released clients that resume via forwardedProps.command.resume stop
    // sending a resume directive when they see the structured outcome, so it
    // stays opt-in until they adopt RunAgentInput.resume[]. See
    // LangGraphAgentConfig.emitInterruptOutcome.
    const includeOutcome =
      this.emitInterruptOutcome || !this.enableLegacyOnInterruptEvent;
    this.dispatchEvent({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      ...(includeOutcome
        ? {
            outcome: {
              type: "interrupt",
              interrupts: aguiInterrupts,
            } satisfies RunFinishedInterruptOutcome,
          }
        : {}),
    });
  }

  protected async onInitialize(
    input: RunAgentInput,
    subscribers: AgentSubscriber[],
  ) {
    // Back-compat: when emitInterruptOutcome is enabled, an interrupted run sets
    // AbstractAgent.pendingInterrupts. A client still resuming via the legacy
    // forwardedProps.command.resume channel never populates RunAgentInput.resume[],
    // so the base lifecycle would reject the resume run. Drop the tracked
    // interrupts for that case — runAgentStream resolves the legacy resume itself.
    reconcileLegacyResumeInterrupts(this, input);
    return super.onInitialize(input, subscribers);
  }

  run(input: RunAgentInput) {
    return new Observable<ProcessedEvents>((subscriber) => {
      this.runAgentStream(input, subscriber).catch((err) => {
        console.error(`[LangGraph] runAgentStream error:`, err);
        if (!subscriber.closed) {
          subscriber.error(err);
        }
      });
      return () => {};
    });
  }

  /**
   * Detect whether the connected server speaks the v3 streaming
   * protocol. The v3 dev/platform server exposes a
   * `/threads/:id/stream/events` route; older (≤0.6-era) servers do
   * not, returning 404 for it.
   *
   * The langgraph team's recommended probe is an OPTIONS request to
   * that endpoint: an existing route answers with a non-404 status
   * (200/204/405/401/403…), while an absent route returns 404. OPTIONS
   * avoids starting a run or mutating thread state.
   *
   * Result is memoised on the shared `v3Support` holder (a deployment's
   * protocol version is stable), so the probe runs at most once per
   * agent lineage. On any transport error we fall back to legacy (the
   * conservative choice that keeps older servers working).
   */
  protected async supportsV3(threadId: string): Promise<boolean> {
    if (this.v3Support.value !== undefined) return this.v3Support.value;

    const base = (this.config.deploymentUrl ?? "").replace(/\/+$/, "");
    const url = `${base}/threads/${threadId}/stream/events`;
    try {
      const response = await fetch(url, {
        method: "OPTIONS",
        headers: this.buildProbeHeaders(),
      });
      this.v3Support.value = response.status !== 404;
    } catch {
      // Network/transport failure → assume legacy to stay safe.
      this.v3Support.value = false;
    }
    return this.v3Support.value;
  }

  /**
   * Best-effort headers for the v3 OPTIONS probe: static property
   * headers, then per-request dynamic headers, then the API key as
   * `x-api-key`. Auth isn't strictly required to tell a missing route
   * (404) from a present one (which answers even when unauthorized),
   * but we forward what we have so proxies that gate OPTIONS still let
   * the request through.
   */
  private buildProbeHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...(this.config.propertyHeaders ?? {}),
    };
    const dynamic = this.config.headerFactory?.() ?? this.headers;
    if (dynamic) Object.assign(headers, dynamic);
    if (this.config.langsmithApiKey) {
      headers["x-api-key"] = this.config.langsmithApiKey;
    }
    return headers;
  }

  /**
   * Get-or-create the cached `(ThreadStream, custom:agui subscription)`
   * pair for a thread. Shared across `clone()` instances by reference
   * (see `clone()`), so every request to a given threadId reuses the
   * same SSE wire and never receives a server-side replay of prior
   * runs' events.
   */
  protected async acquireTransformerThread(
    threadId: string,
  ): Promise<TransformerThreadEntry> {
    const cached = this.transformerThreads.get(threadId);
    if (cached) return cached;
    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }
    const thread = this.client.threads.stream(threadId, {
      assistantId: this.assistant.assistant_id,
    });
    // Subscribe to all standard v3 channels. The compile-time
    // `aguiTransformer` is NOT in the loop here — we receive raw
    // ProtocolEvents (lifecycle, messages, values, updates,
    // checkpoints, tasks, input, custom) and do the translation
    // ourselves on the client side. Multi-channel + non-array params
    // disables the SDK's `unwrapNamedCustom`, so for-await yields the
    // raw Event envelope (method + params), not unwrapped payloads.
    const aguiSub = (await thread.subscribe(DEFAULT_STREAM_MODES)) as SubscriptionHandle<any, ProcessedEvents>;
    const entry: TransformerThreadEntry = { thread, aguiSub };
    this.transformerThreads.set(threadId, entry);
    return entry;
  }

  /**
   * Resolve the interrupt to resume against, given a possibly-empty
   * `streamingThread.interrupts` (populated live by the SDK's
   * lifecycle watcher) and the server-side `agentState.tasks` array
   * (a cold-start fallback in case our ThreadStream cache was rebuilt
   * but the server still has the interrupt parked).
   *
   * Returns `undefined` when there's no resume to perform.
   */
  protected findPendingInterrupt(
    streamingThread: ThreadStream,
    agentState: ThreadState<State>,
    resumeRequested: boolean,
  ): { interruptId: string; namespace: readonly string[] } | undefined {
    if (!resumeRequested) return undefined;
    const live = (streamingThread as { interrupts?: Array<{ interruptId: string; namespace: readonly string[] }> })
      .interrupts;
    const last = live?.[live.length - 1];
    if (last?.interruptId) {
      return { interruptId: last.interruptId, namespace: last.namespace };
    }
    const fallback = (agentState.tasks ?? [])
      .flatMap((t: any) =>
        (t.interrupts ?? []).map((i: any) => ({ task: t, interrupt: i })),
      )
      .pop();
    if (fallback?.interrupt?.id) {
      return {
        interruptId: fallback.interrupt.id,
        namespace: fallback.task?.checkpoint?.checkpoint_ns?.split("|") ?? [],
      };
    }
    return undefined;
  }

  /**
   * Register a one-shot listener that pauses the agui subscription when
   * the run's root lifecycle terminates. `submitRun`'s
   * `#prepareForNextRun` auto-resumes between runs, so pause is
   * cheaper than close — the persistent sub stays alive across the
   * lifetime of the cached ThreadStream.
   */
  protected watchForRootTerminal(
    streamingThread: ThreadStream,
    aguiSub: SubscriptionHandle<any, ProcessedEvents>,
  ): () => void {
    const TERMINAL = new Set(["completed", "failed", "interrupted"]);
    const unsubscribe = streamingThread.onEvent((event) => {
      const ev = event as {
        method?: string;
        params?: { namespace?: unknown; data?: { event?: string } };
      };
      if (
        ev.method === "lifecycle" &&
        Array.isArray(ev.params?.namespace) &&
        ev.params!.namespace.length === 0 &&
        TERMINAL.has(ev.params!.data?.event ?? "")
      ) {
        aguiSub.pause();
        unsubscribe();
      }
    });
    return unsubscribe;
  }

  async runAgentStream(
    input: RunAgentExtendedInput,
    subscriber: Subscriber<ProcessedEvents>,
  ) {
    this.activeRun = {
      id: input.runId,
      threadId: input.threadId,
      hasFunctionStreaming: false,
      modelMadeToolCall: false,
      textBlockMessageIds: new Map(),
      toolBlocks: new Map(),
      reasoningBlocks: new Map(),
    };
    this.pendingReasoningId = undefined;
    // Reset per-run flags
    this.cancelRequested = false;
    this.cancelSent = false;
    this.eventsStreamActive = false;
    this.subscriber = subscriber;
    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }
    const threadId = input.threadId ?? randomUUID();
    const streamMode =
      input.forwardedProps?.streamMode ??
      ([
        "events",
        "values",
        "updates",
        "messages-tuple",
          "custom",
      ] satisfies StreamMode[]);

    const preparedStream = await this.prepareStream(
      { ...input, threadId },
      streamMode,
    );

    if (!preparedStream) {
      return subscriber.error("No stream to regenerate");
    }

    // prepareStream/prepareRegenerateStream decide the protocol via the
    // OPTIONS probe and stamp `activeRun.isV3`. Route to the matching
    // event bundle: v3 reads raw ProtocolEvents, legacy reads classic
    // SSE chunks.
    const streamModesArg = [
      ...DEFAULT_STREAM_MODES,
      ...(Array.isArray(streamMode) ? streamMode : [streamMode]),
    ] as StreamMode[];

    if (this.activeRun?.isV3) {
      await this.handleStreamEventsV3(
        preparedStream,
        threadId,
        subscriber,
        input,
        streamModesArg,
      );
    } else {
      await this.handleStreamEventsV2(
        preparedStream,
        threadId,
        subscriber,
        input,
        streamModesArg,
      );
    }
  }

  async prepareRegenerateStream(
    input: RegenerateInput,
    streamMode: StreamMode | StreamMode[],
  ) {
    const { threadId, messageCheckpoint, forwardedProps } = input;

    const timeTravelCheckpoint = await this.getCheckpointByMessage(
      messageCheckpoint!.id!,
      threadId,
    );
    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }

    if (!timeTravelCheckpoint) {
      return this.subscriber.error("No checkpoint found for message");
    }

    const fork = await this.client.threads.updateState(threadId, {
      values: this.langGraphDefaultMergeState(
        timeTravelCheckpoint.values,
        [],
        input,
      ),
      checkpointId: timeTravelCheckpoint.checkpoint.checkpoint_id!,
      asNode: timeTravelCheckpoint.next?.[0] ?? "__start__",
    });

    let payloadConfig: LangGraphConfig | undefined;
    const configsToMerge = [
      this.assistantConfig,
      forwardedProps?.config,
    ].filter(Boolean) as LangGraphConfig[];
    if (configsToMerge.length) {
      payloadConfig = await this.mergeConfigs({
        configs: configsToMerge,
        assistant: this.assistant,
        schemaKeys: this.activeRun!.schemaKeys ?? null,
      });
    }

    const forkedCheckpointId = (fork as { checkpoint: { checkpoint_id: string } })
      .checkpoint.checkpoint_id;
    const regenInput = this.langGraphDefaultMergeState(
      timeTravelCheckpoint.values,
      [messageCheckpoint],
      input,
    );
    const payload = {
      ...(input.forwardedProps ?? {}),
      input: regenInput,
      checkpointId: forkedCheckpointId,
      streamMode,
      config: payloadConfig,
    };

    const isV3 = await this.supportsV3(threadId);
    this.activeRun!.isV3 = isV3;

    if (isV3) {
      // v3-path regen: cached ThreadStream + persistent custom:agui
      // sub, with the fork expressed via v3 `forkFrom` so the dev
      // server roots the new run at the chosen checkpoint.
      // Resume semantics don't apply on regen.
      const sanitizedInput = sanitizeAssistantMessages(regenInput as Record<string, unknown>);
      const { thread: streamingThread, aguiSub } =
        await this.acquireTransformerThread(threadId);
      const unsubscribeOnEvent = this.watchForRootTerminal(streamingThread, aguiSub);

      const submitted = await streamingThread.submitRun({
        ...(input.forwardedProps ?? {}),
        input: sanitizedInput,
        config: payloadConfig,
        metadata: (input.forwardedProps as { metadata?: Record<string, unknown> })?.metadata,
        forkFrom: { checkpointId: forkedCheckpointId },
      });
      this.activeRun!.id = submitted?.run_id ?? this.activeRun!.id;

      return {
        streamResponse: aguiSub,
        state: timeTravelCheckpoint as ThreadState<State>,
        streamMode,
        close: () => {
          unsubscribeOnEvent();
        },
      };
    }

    return {
      streamResponse: this.client.runs.stream(
        threadId,
        this.assistant.assistant_id,
        payload,
      ),
      state: timeTravelCheckpoint as ThreadState<State>,
      streamMode,
    };
  }

  async prepareStream(
    input: RunAgentExtendedInput,
    streamMode: StreamMode | StreamMode[],
  ) {
    let {
      threadId: inputThreadId,
      state: inputState,
      messages,
      tools,
      context,
      forwardedProps,
    } = input;
    // If a manual emittance happens, it is the ultimate source of truth of state, unless a node has exited.
    // Therefore, this value should either hold null, or the only edition of state that should be used.
    this.activeRun!.manuallyEmittedState = null;

    const nodeNameInput = forwardedProps?.nodeName;

    const threadId = inputThreadId ?? randomUUID();

    const aguiResume: ResumeEntry[] | undefined =
      input.resume && input.resume.length ? input.resume : undefined;
    const legacyResume = forwardedProps?.command?.resume;

    if (aguiResume && legacyResume !== undefined) {
      console.warn(
        "[@ag-ui/langgraph] both input.resume and forwardedProps.command.resume were provided; input.resume wins.",
      );
    } else if (!aguiResume && legacyResume !== undefined) {
      console.warn(
        "[@ag-ui/langgraph] forwardedProps.command.resume is deprecated; send RunAgentInput.resume[] instead.",
      );
    }

    const hasResume = aguiResume !== undefined || legacyResume !== undefined;

    if (!this.assistant) {
      this.assistant = await this.getAssistant();
    }

    const thread = await this.getOrCreateThread(
      threadId,
      forwardedProps?.threadMetadata,
    );
    this.activeRun!.threadId = thread.thread_id;

    const agentState: ThreadState<State> =
      (await this.client.threads.getState(thread.thread_id)) ??
      ({ values: {} } as ThreadState<State>);
    const agentStateMessages = agentState.values.messages ?? [];
    const inputMessagesToLangchain = aguiMessagesToLangChain(messages);
    const stateValuesDiff = this.langGraphDefaultMergeState(
      { ...inputState, messages: agentStateMessages },
      inputMessagesToLangchain,
      input,
    );
    // Messages are a combination of existing messages in state + everything that was newly sent
    let threadState = {
      ...agentState,
      values: {
        ...stateValuesDiff,
        messages: [...agentStateMessages, ...(stateValuesDiff.messages ?? [])],
      },
    };
    let stateValues = threadState.values;
    this.activeRun!.schemaKeys = await this.getSchemaKeys();

    // Compare non-system message counts to detect regeneration.
    // Both sides must filter system messages for an accurate comparison,
    // since the LangGraph state may contain system messages injected by
    // the connector (e.g. CopilotKit context) that the frontend doesn't track.
    const stateNonSystemCount = agentStateMessages.filter(
      (m: LangGraphPlatformMessage) => m.type !== "system",
    ).length;
    const inputNonSystemCount = messages.filter(
      (m) => m.role !== "system",
    ).length;

    // Skip regeneration detection when a resume is set — a resume from
    // interrupt is explicitly NOT a regeneration. On the second interrupt-resume
    // cycle the LangGraph thread state has accumulated tool/AI messages from the
    // first interrupt while the frontend's input.messages hasn't, which would
    // otherwise trigger the regeneration path and ignore the resume.
    if (!hasResume && stateNonSystemCount > inputNonSystemCount) {
      // A higher checkpoint count than the frontend sent does NOT always mean a
      // regeneration. If an SSE stream dropped before MESSAGES_SNAPSHOT, the
      // client never learned the persisted message IDs and resends the new user
      // turn with a freshly generated UUID, making the checkpoint legitimately
      // longer than the input even though this is a continuation. Routing that
      // into regeneration calls getCheckpointByMessage with an ID that was never
      // persisted, which throws "Message not found" and breaks the thread on
      // every subsequent turn (#1278).
      //
      // Only treat the count mismatch as a regeneration when the incoming IDs are
      // NOT already a subset of the checkpoint (a genuine edit) AND the last user
      // message's ID actually exists in the checkpoint. Otherwise fall through to
      // a normal continuation stream so the end-of-run MESSAGES_SNAPSHOT re-syncs
      // the client. This continuation/regeneration decision mirrors the Python
      // guard in prepare_stream. The outer count pre-filter differs only in which
      // inputs enter this block (this side excludes system messages from both
      // counts, Python only from the incoming side); both reach the same
      // continuation-vs-regenerate decision for the recovery case.
      const checkpointIds = new Set(
        (agentStateMessages as LangGraphPlatformMessage[])
          .map((m) => m.id)
          .filter((id): id is string => Boolean(id)),
      );
      // Tool results are excluded from the comparison: connectors (e.g.
      // CopilotKit) reassign tool-message IDs that won't match the checkpoint's
      // placeholders. Human/AI IDs are stable and sufficient to distinguish a
      // continuation from a genuine regeneration.
      const incomingNonToolIds = messages
        .filter((m) => m.role !== "tool" && Boolean(m.id))
        .map((m) => m.id as string);
      const isContinuation =
        incomingNonToolIds.length > 0 &&
        incomingNonToolIds.every((id) => checkpointIds.has(id));

      if (!isContinuation) {
        let lastUserMessage: LangGraphMessage | null = null;
        let lastUserMessageId: string | undefined;
        // Find the last user message by working backwards from the end.
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            lastUserMessageId = messages[i].id;
            lastUserMessage = aguiMessagesToLangChain([messages[i]])[0];
            break;
          }
        }

        if (
          lastUserMessage &&
          lastUserMessageId &&
          checkpointIds.has(lastUserMessageId)
        ) {
          return this.prepareRegenerateStream(
            { ...input, messageCheckpoint: lastUserMessage },
            streamMode,
          );
        }
      }
    }
    this.activeRun!.graphInfo = await this.client.assistants.getGraph(
      this.assistant.assistant_id,
    );

    const mode =
      !hasResume &&
      threadId &&
      this.activeRun!.nodeName != "__end__" &&
      this.activeRun!.nodeName
        ? "continue"
        : "start";

    if (mode === "continue") {
      const nodeBefore = this.activeRun!.graphInfo.edges.find(
        (e) => e.target === this.activeRun!.nodeName,
      );
      await this.client.threads.updateState(threadId, {
        values: inputState,
        asNode: nodeBefore?.source,
      });
    }

    const payloadInput = getStreamPayloadInput({
      mode,
      state: stateValues,
      schemaKeys: this.activeRun!.schemaKeys,
    });

    let payloadConfig: LangGraphConfig | undefined;
    const configsToMerge = [
      this.assistantConfig,
      forwardedProps?.config,
    ].filter(Boolean) as LangGraphConfig[];
    if (configsToMerge.length) {
      payloadConfig = await this.mergeConfigs({
        configs: configsToMerge,
        assistant: this.assistant,
        schemaKeys: this.activeRun!.schemaKeys,
      });
    }
    // forwardedProps is optional on the input; the SSE-drop recovery now reaches
    // this continuation path (instead of returning early via regenerate), so guard
    // against an undefined value here rather than throwing on destructure.
    const { command, ...restProps } = forwardedProps ?? {};

    // Collect interrupts from ALL tasks, not just tasks[0] (fixes #1409).
    // The SDK doesn't export a Task type, so we use `any` here.
    const interrupts = (agentState.tasks ?? []).flatMap(
      (t: any) => t.interrupts ?? [],
    ) as LangGraphInterrupt[];

    let effectiveCommand = command;

    if (aguiResume) {
      effectiveCommand = {
        ...(command ?? {}),
        resume: this.buildCommandResumeFromAgui(aguiResume, {
          openInterrupts: this.interruptsToAGUI(interrupts),
        }),
      };
    } else if (effectiveCommand?.resume && typeof effectiveCommand.resume === "string") {
      try {
        effectiveCommand.resume = JSON.parse(effectiveCommand.resume);
      } catch {
        // Keep as string if not valid JSON
      }
    }

    // Build context from configurable keys that match the graph's context_schema.
    // RunAgentInput.context is a separate ag-ui concept (Array<{description, value}>)
    // that already flows into the graph's input state via langGraphDefaultMergeState.
    // It does NOT go into the payload-level context field.
    const contextSchemaKeys = new Set(
      this.activeRun!.schemaKeys?.context ?? [],
    );
    const configurable = payloadConfig?.configurable ?? {};

    // Partition configurable: keys declared in context_schema go to context,
    // the rest stay in configurable (for backward compat with older servers).
    const contextFromConfigurable: Record<string, unknown> = {};
    const remainingConfigurable: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(configurable)) {
      if (contextSchemaKeys.has(key)) {
        contextFromConfigurable[key] = value;
      } else {
        remainingConfigurable[key] = value;
      }
    }

    // Build payload-level context ONLY from configurable keys matching context_schema.
    // Do NOT spread RunAgentInput.context here — it is Array<{description, value}>,
    // not Record<string, unknown>, and belongs in the graph's input state, not the
    // payload-level context field.
    const mergedContext = { ...contextFromConfigurable };

    // Build final config: if remaining configurable is empty, omit it
    const finalConfig = payloadConfig
      ? {
          ...payloadConfig,
          configurable:
            Object.keys(remainingConfigurable).length > 0
              ? remainingConfigurable
              : undefined,
        }
      : undefined;

    // If both context and configurable would be present, context wins
    // (matches langgraph-api >= 0.7.x expectation).
    // If context is empty, omit it (backward compat with older servers).
    const hasContext = Object.keys(mergedContext).length > 0;
    const hasConfigurable =
      finalConfig?.configurable != null &&
      Object.keys(finalConfig.configurable).length > 0;

    // Warn if non-schema configurable keys are being dropped because context wins
    if (hasContext && hasConfigurable) {
      const droppedKeys = Object.keys(remainingConfigurable);
      if (droppedKeys.length > 0) {
        console.warn(
          `[@ag-ui/langgraph] Dropping configurable keys not in context_schema: [${droppedKeys.join(", ")}]. Use context instead.`,
        );
      }
    }

    // Strip configurable cleanly using destructuring to avoid leaving an
    // explicit `configurable: undefined` key in the serialized payload.
    const configForPayloadBase = (() => {
      if (!finalConfig) return undefined;
      if (hasConfigurable && !hasContext) return finalConfig; // old-style: configurable only
      const { configurable: _stripped, ...configSansConfigurable } =
        finalConfig;
      return Object.keys(configSansConfigurable).length > 0
        ? configSansConfigurable
        : undefined;
    })();

    // Forward x-* request headers into payload.config.configurable so the
    // Python middleware can extract them via _extract_forwarded_headers_from_config.
    // This is infrastructure metadata (correlation IDs, x-aimock-context, etc.),
    // NOT graph context, so it must ride in configurable regardless of whether
    // context_schema wins. Only x-* headers are forwarded; auth/content-type
    // headers stay on the HTTP wire via the onRequest hook.
    const forwardedHeaders = Object.fromEntries(
      Object.entries(this.headers ?? {}).filter(([k]) =>
        k.toLowerCase().startsWith("x-"),
      ),
    );
    const configForPayload =
      Object.keys(forwardedHeaders).length > 0
        ? {
            ...(configForPayloadBase ?? {}),
            configurable: {
              ...((
                configForPayloadBase as {
                  configurable?: Record<string, unknown>;
                }
              )?.configurable ?? {}),
              copilotkit_forwarded_headers: forwardedHeaders,
            },
          }
        : configForPayloadBase;

    const payload: Record<string, unknown> = {
      ...restProps,
      command: effectiveCommand,
      streamMode,
      input: payloadInput,
      config: configForPayload,
      ...(hasContext ? { context: mergedContext } : {}),
    };

    // If there are still outstanding unresolved interrupts, we must force resolution of them before moving forward
    if (interrupts?.length && !hasResume) {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: input.runId,
      });
      this.handleNodeChange(nodeNameInput);

      this.dispatchInterruptFinish({
        threadId,
        runId: input.runId,
        lgInterrupts: interrupts,
      });

      return this.subscriber.complete();
    }

    const isV3 = await this.supportsV3(threadId);
    this.activeRun!.isV3 = isV3;

    if (!isV3) {
      // Legacy (≤0.6-era) server: no v3 stream/events route. Drive the
      // run through the classic `runs.stream` SSE path; the v2 event
      // bundle (handleStreamEventsV2/handleSingleEventV2) translates it.
      return {
        streamResponse: this.client.runs.stream(
          threadId,
          this.assistant.assistant_id,
          payload,
        ),
        state: threadState as ThreadState<State>,
      };
    }

    const sanitizedInput = sanitizeAssistantMessages(payloadInput);
    const { thread: streamingThread, aguiSub } =
        await this.acquireTransformerThread(threadId);
    const unsubscribeOnEvent = this.watchForRootTerminal(streamingThread, aguiSub);

    const resumeRequested =
        forwardedProps?.command?.resume !== undefined &&
        forwardedProps?.command?.resume !== null;
    const pendingInterrupt = this.findPendingInterrupt(
        streamingThread,
        agentState,
        resumeRequested,
    );

    let runId: string | undefined;
    if (resumeRequested && pendingInterrupt) {
      // Resume routes through input.respond on the cached
      // ThreadStream. The server assigns a fresh run_id we don't
      // see in the response; activeRun.id stays stale until an
      // event with the new id flows through.
      await streamingThread.respondInput({
        namespace: pendingInterrupt.namespace,
        interrupt_id: pendingInterrupt.interruptId,
        response: forwardedProps!.command!.resume,
      });
    } else {
      const submitted = await streamingThread.submitRun({
        ...payload,
        input: sanitizedInput,
        config: payload.config,
        metadata: payload.metadata as Record<string, unknown>,
      });
      runId = submitted?.run_id;
    }
    this.activeRun!.id = runId ?? this.activeRun!.id;

    return {
      streamResponse: aguiSub,
      state: threadState as ThreadState<State>,
      // Per-run cleanup only — the cached thread + sub live on for
      // the next request on this threadId.
      close: () => {
        unsubscribeOnEvent();
      },
    };
  }

  async handleStreamEventsV2(
    stream: Awaited<
      | ReturnType<typeof this.prepareStream>
      | ReturnType<typeof this.prepareRegenerateStream>
    >,
    threadId: string,
    subscriber: Subscriber<ProcessedEvents>,
    input: RunAgentExtendedInput,
    streamModes: StreamMode | StreamMode[],
  ) {
    const { forwardedProps } = input;
    const nodeNameInput = forwardedProps?.nodeName;
    this.subscriber = subscriber;
    let shouldExit = false;
    if (!stream) return;
    // Reset per-run tracking of emitted tool call IDs
    this.emittedToolCallStartIds = new Set<string>();

    let { streamResponse, state } = stream;

    this.activeRun!.prevNodeName = null;
    let latestStateValues = {} as ThreadState<State>["values"];
    let updatedState = state;

    try {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun!.id,
      });
      this.handleNodeChange(nodeNameInput);

      for await (let streamResponseChunk of streamResponse) {
        // If a cancel was requested and we haven't sent it yet, try now.
        if (
          this.cancelRequested &&
          !this.cancelSent &&
          this.activeRun?.threadId &&
          this.activeRun?.id
        ) {
          try {
            await this.client.runs.cancel(
              this.activeRun.threadId,
              this.activeRun.id,
            );
          } catch (_) {
            // Ignore cancellation errors
          } finally {
            this.cancelSent = true;
          }
          // Best-effort: ask iterator to close early
          try {
            // Many async iterables used for streaming implement return()
            await (streamResponse as any)?.return?.();
          } catch (_) {}
          break;
        }

        const subgraphsStreamEnabled =
          input.forwardedProps?.streamSubgraphs ?? true;
        const isSubgraphStream =
          subgraphsStreamEnabled &&
          (streamResponseChunk.event.startsWith("events") ||
            streamResponseChunk.event.startsWith("values"));

        // "messages-tuple" stream mode produces SSE events with type "messages",
        // so we need to check for that mapping in addition to the direct mode name.
        const isMessagesTupleEvent =
          streamResponseChunk.event === "messages" &&
          (Array.isArray(streamModes) ? streamModes : [streamModes]).includes(
            "messages-tuple" as StreamMode,
          );

        // @ts-ignore
        if (
          !streamModes.includes(streamResponseChunk.event as StreamMode) &&
          !isSubgraphStream &&
          !isMessagesTupleEvent &&
          streamResponseChunk.event !== "error"
        ) {
          continue;
        }

        // Force event type, as data is not properly defined on the LG side.
        type EventsChunkData = {
          __interrupt__?: any;
          metadata: Record<string, any>;
          event: string;
          data: any;
          [key: string]: unknown;
        };
        const chunk = streamResponseChunk as EventsStreamEvent & {
          data: EventsChunkData;
        };

        if (streamResponseChunk.event === "error") {
          this.dispatchEvent({
            type: EventType.RUN_ERROR,
            message: streamResponseChunk.data.message,
            rawEvent: streamResponseChunk,
          });
          break;
        }

        if (streamResponseChunk.event === "updates") {
          continue;
        }

        if (streamResponseChunk.event === "values") {
          latestStateValues = {
            ...latestStateValues,
            ...chunk.data,
          };
          continue;
        } else if (
          subgraphsStreamEnabled &&
          chunk.event.startsWith("values|")
        ) {
          latestStateValues = {
            ...latestStateValues,
            ...chunk.data,
          };
          continue;
        }

        const chunkData = chunk.data;
        // messages-tuple chunks arrive as [AIMessageChunk, metadata] arrays;
        // events-mode chunks are objects with metadata/event properties. Read
        // metadata from the right slot so langgraph_node is extracted in both
        // cases (otherwise messages-tuple-only flows never call
        // handleNodeChange and node-scoped behavior degrades to no-op).
        const metadata = Array.isArray(chunkData)
          ? (chunkData[1] ?? {})
          : (chunkData.metadata ?? {});
        const currentNodeName = metadata.langgraph_node;
        const eventType = Array.isArray(chunkData)
          ? undefined
          : chunkData.event;

        // Subgraph detection via langgraph_checkpoint_ns
        // ns format: "" | "node:uuid" | "node:uuid|inner:uuid"
        const ns: string = metadata.langgraph_checkpoint_ns ?? "";
        const nsRoot = ns.split("|")[0].split(":")[0];
        if (ns.includes("|") && nsRoot) this.subgraphs.add(nsRoot);
        const currentSubgraph =
          nsRoot && this.subgraphs.has(nsRoot) ? nsRoot : ROOT_SUBGRAPH_NAME;

        if (currentSubgraph !== this.currentSubgraph) {
          this.currentSubgraph = currentSubgraph;
          await this.getStateAndMessagesSnapshots(threadId);
        }

        // Set server-assigned run id as soon as available
        if (metadata.run_id) {
          this.activeRun!.id = metadata.run_id;
          this.activeRun!.serverRunIdKnown = true;
          // If cancel was requested earlier (before server id was known), send it now.
          if (
            this.cancelRequested &&
            !this.cancelSent &&
            this.activeRun?.threadId
          ) {
            try {
              await this.client.runs.cancel(
                this.activeRun.threadId!,
                this.activeRun.id,
              );
            } catch (_) {
              // Ignore cancellation errors
            } finally {
              this.cancelSent = true;
            }
          }
        }

        if (currentNodeName && currentNodeName !== this.activeRun!.nodeName) {
          this.handleNodeChange(currentNodeName);
        }

        shouldExit =
          shouldExit ||
          (eventType === LangGraphEventTypes.OnCustomEvent &&
            chunkData.name === CustomEventNames.Exit);

        // Parity with Python reader (langgraph_agent.py:447): update local state
        // cache from on_chain_end outputs so state stays fresh across node boundaries
        // without relying on a `values` stream chunk after every step.
        // LangGraph JS doesn't emit `values` chunks with the latest state between
        // tool execution and run end, so without this update, intermediate
        // STATE_SNAPSHOTs go stale after a tool Command updates state.
        if (
          eventType === LangGraphEventTypes.OnChainEnd &&
          chunkData.data?.output != null
        ) {
          const output: any = chunkData.data.output;
          if (typeof output === "object" && !Array.isArray(output)) {
            latestStateValues = { ...latestStateValues, ...output };
          } else if (Array.isArray(output)) {
            for (const item of output) {
              if (
                item &&
                typeof item === "object" &&
                (item as any).lg_name === "Command" &&
                (item as any).update &&
                typeof (item as any).update === "object"
              ) {
                latestStateValues = {
                  ...latestStateValues,
                  ...(item as any).update,
                };
              }
            }
          }
        }

        if (
          eventType === LangGraphEventTypes.OnChainEnd &&
          this.activeRun!.nodeName === currentNodeName
        ) {
          this.activeRun!.exitingNode = true;
        }
        if (this.activeRun!.exitingNode) {
          // Persist manually-emitted keys into latestStateValues before clearing,
          // so the next STATE_SNAPSHOT (which falls back to latestStateValues)
          // doesn't lose the streamed-in fields if the graph's own values/Command
          // chunk for those fields hasn't landed yet.
          if (
            this.activeRun!.manuallyEmittedState &&
            typeof this.activeRun!.manuallyEmittedState === "object"
          ) {
            latestStateValues = {
              ...latestStateValues,
              ...this.activeRun!.manuallyEmittedState,
            };
          }
          this.activeRun!.manuallyEmittedState = null;
        }

        // we only want to update the node name under certain conditions
        // since we don't need any internal node names to be sent to the frontend
        if (
          this.activeRun!.graphInfo?.["nodes"].some(
            (node) => node.id === currentNodeName,
          )
        ) {
          this.handleNodeChange(currentNodeName);
        }

        updatedState.values =
          this.activeRun!.manuallyEmittedState ?? latestStateValues;

        if (!this.activeRun!.nodeName) {
          continue;
        }

        const hasStateDiff =
          JSON.stringify(updatedState) !== JSON.stringify(state);
        // Suppress STATE_SNAPSHOT while a message is in progress, or while a
        // predict_state tool call is streaming args (modelMadeToolCall=true).
        // During tool arg streaming the graph state does not yet reflect the
        // forthcoming update, so emitting a snapshot would clobber optimistic
        // UI state. Flag is cleared in OnToolEnd/OnToolError.
        //
        // Diverges from Python: TS blocks ALL snapshot kinds (state-diff,
        // node change, node exit) while the flag is set; Python only
        // suppresses on node exit. A post-run snapshot runs the safety net.
        if (
          !this.activeRun!.modelMadeToolCall &&
          (hasStateDiff ||
            this.activeRun!.prevNodeName != this.activeRun!.nodeName ||
            this.activeRun!.exitingNode) &&
          !Boolean(this.getMessageInProgress(this.activeRun!.id))
        ) {
          state = updatedState;
          this.activeRun!.prevNodeName = this.activeRun!.nodeName;

          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot(state),
            rawEvent: chunk,
          });
        }

        this.dispatchEvent({
          type: EventType.RAW,
          event: chunkData,
        });

        this.handleSingleEventV2(chunkData);
      }

      state = await this.client.threads.getState(threadId);
      const tasks = state.tasks;
      // Collect interrupts from ALL tasks, not just tasks[0] (fixes #1409)
      const interrupts = (tasks ?? []).flatMap(
        (t: any) => t.interrupts ?? [],
      ) as LangGraphInterrupt[];
      const isEndNode = state.next.length === 0;
      const writes = state.metadata?.writes ?? {};

      // Initialize a new node name to use in the next if block
      let newNodeName = this.activeRun!.nodeName!;

      if (!interrupts?.length) {
        newNodeName = isEndNode
          ? "__end__"
          : (state.next[0] ?? Object.keys(writes)[0]);
      }

      this.handleNodeChange(newNodeName);
      // Immediately turn off new step
      this.handleNodeChange(undefined);

      await this.getStateAndMessagesSnapshots(threadId);

      if (interrupts.length) {
        this.dispatchInterruptFinish({
          threadId,
          runId: this.activeRun!.id,
          lgInterrupts: interrupts,
        });
      } else {
        this.dispatchEvent({
          type: EventType.RUN_FINISHED,
          threadId,
          runId: this.activeRun!.id,
        });
      }

      // Reset cancel flags when run completes
      this.cancelRequested = false;
      this.cancelSent = false;
      this.activeRun = undefined;
      return subscriber.complete();
    } catch (e) {
      return subscriber.error(e);
    }
  }

  handleSingleEventV2(event: any): void {
    // messages-tuple data arrives as [AIMessageChunk, metadata] arrays,
    // not objects with an .event property like events-mode data.
    if (Array.isArray(event)) {
      if (!this.eventsStreamActive) {
        this.handleMessagesTupleEvent(event);
      }
      return;
    }

    // Track if events-mode streaming is producing data — when it does,
    // messages-tuple events are skipped to avoid duplicate streaming.
    if (event.event === LangGraphEventTypes.OnChatModelStream) {
      this.eventsStreamActive = true;
    }

    switch (event.event) {
      case LangGraphEventTypes.OnChatModelStream:
        let shouldEmitMessages = event.metadata["emit-messages"] ?? true;
        let shouldEmitToolCalls = event.metadata["emit-tool-calls"] ?? true;

        if (event.data.chunk.response_metadata.finish_reason) return;
        let currentStream = this.getMessageInProgress(this.activeRun!.id);
        const hasCurrentStream = Boolean(currentStream?.id);
        const toolCallData = event.data.chunk.tool_call_chunks?.[0];
        const toolCallUsedToPredictState = event.metadata[
          "predict_state"
        ]?.some(
          (predictStateTool: PredictStateTool) =>
            predictStateTool.tool === toolCallData?.name,
        );

        const isToolCallStartEvent = !hasCurrentStream && toolCallData?.name;
        const isToolCallArgsEvent =
          hasCurrentStream && currentStream?.toolCallId && toolCallData?.args;
        const isToolCallEndEvent =
          hasCurrentStream && currentStream?.toolCallId && !toolCallData;

        if (isToolCallEndEvent || isToolCallArgsEvent || isToolCallStartEvent) {
          this.activeRun!.hasFunctionStreaming = true;
        }

        const reasoningData = resolveReasoningContent(event.data);
        const encryptedReasoningData = resolveEncryptedReasoningContent(
          event.data,
        );
        const messageContent = resolveMessageContent(event.data.chunk.content);
        const isMessageContentEvent = Boolean(!toolCallData && messageContent);

        const isMessageEndEvent =
          hasCurrentStream &&
          !currentStream?.toolCallId &&
          !isMessageContentEvent;

        if (reasoningData) {
          this.handleReasoningEvent(reasoningData);
          break;
        }

        // Handle redacted_thinking blocks (encrypted reasoning content)
        if (encryptedReasoningData && this.reasoningProcess) {
          this.dispatchEvent({
            type: EventType.REASONING_ENCRYPTED_VALUE,
            subtype: "message",
            entityId: this.reasoningProcess.messageId,
            encryptedValue: encryptedReasoningData,
          });
          break;
        }

        if (!reasoningData && this.reasoningProcess) {
          // Emit signature as encrypted value if accumulated during reasoning
          if (this.reasoningProcess.signature) {
            this.dispatchEvent({
              type: EventType.REASONING_ENCRYPTED_VALUE,
              subtype: "message",
              entityId: this.reasoningProcess.messageId,
              encryptedValue: this.reasoningProcess.signature,
            });
          }
          this.dispatchEvent({
            type: EventType.REASONING_MESSAGE_END,
            messageId: this.reasoningProcess.messageId,
          });
          this.dispatchEvent({
            type: EventType.REASONING_END,
            messageId: this.reasoningProcess.messageId,
          });
          this.reasoningProcess = null;
        }

        if (toolCallUsedToPredictState) {
          this.activeRun!.modelMadeToolCall = true;
          this.dispatchEvent({
            type: EventType.CUSTOM,
            name: "PredictState",
            value: event.metadata["predict_state"],
          });
        }

        if (isToolCallEndEvent) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: currentStream?.toolCallId!,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }

        if (isMessageEndEvent) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentStream!.id,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }

        if (isToolCallStartEvent && shouldEmitToolCalls) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: toolCallData.id,
            toolCallName: toolCallData.name,
            parentMessageId: event.data.chunk.id,
            rawEvent: event,
          });
          if (resolved) {
            this.emittedToolCallStartIds.add(toolCallData.id);
            this.setMessageInProgress(this.activeRun!.id, {
              id: event.data.chunk.id,
              toolCallId: toolCallData.id,
              toolCallName: toolCallData.name,
            });
          }
          break;
        }

        // Tool call args: emit ActionExecutionArgs
        if (isToolCallArgsEvent && shouldEmitToolCalls) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: currentStream?.toolCallId!,
            delta: toolCallData.args,
            rawEvent: event,
          });
          break;
        }

        // Message content: emit TextMessageContent
        if (isMessageContentEvent && shouldEmitMessages) {
          // No existing message yet, also init the message
          if (!currentStream) {
            const messageId = this.getOrPinTextMessageId(event.data.chunk.id);
            this.dispatchEvent({
              type: EventType.TEXT_MESSAGE_START,
              role: "assistant",
              messageId,
              rawEvent: event,
            });
            this.setMessageInProgress(this.activeRun!.id, {
              id: messageId,
              toolCallId: null,
              toolCallName: null,
            });
            currentStream = this.getMessageInProgress(this.activeRun!.id);
          }

          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: currentStream!.id,
            delta: messageContent!,
            rawEvent: event,
          });
          break;
        }

        break;
      case LangGraphEventTypes.OnChatModelEnd:
        if (this.getMessageInProgress(this.activeRun!.id)?.toolCallId) {
          const resolved = this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: this.getMessageInProgress(this.activeRun!.id)!
              .toolCallId!,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }
        if (this.getMessageInProgress(this.activeRun!.id)?.id) {
          const resolved = this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: this.getMessageInProgress(this.activeRun!.id)!.id,
            rawEvent: event,
          });
          if (resolved) {
            this.messagesInProcess[this.activeRun!.id] = null;
          }
          break;
        }
        break;
      case LangGraphEventTypes.OnCustomEvent:
        if (event.name === CustomEventNames.ManuallyEmitMessage) {
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_START,
            role: "assistant",
            messageId: event.data.message_id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: event.data.message_id,
            delta: event.data.message,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: event.data.message_id,
            rawEvent: event,
          });
          break;
        }

        if (event.name === CustomEventNames.ManuallyEmitToolCall) {
          this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: event.data.id,
            toolCallName: event.data.name,
            parentMessageId: event.data.id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: event.data.id,
            delta: event.data.args,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: event.data.id,
            rawEvent: event,
          });
          break;
        }

        if (event.name === CustomEventNames.ManuallyEmitState) {
          this.activeRun!.manuallyEmittedState = event.data;
          this.dispatchEvent({
            type: EventType.STATE_SNAPSHOT,
            snapshot: this.getStateSnapshot({
              values: this.activeRun!.manuallyEmittedState!,
            } as ThreadState<State>),
            rawEvent: event,
          });
        }

        this.dispatchEvent({
          type: EventType.CUSTOM,
          name: event.name,
          value: event.data,
          rawEvent: event,
        });
        break;
      case LangGraphEventTypes.OnToolEnd:
        let toolCallOutput = event.data?.output;

        // Command from within a tool. We need to grab result from the tool result message
        if (
          toolCallOutput &&
          !toolCallOutput.tool_call_id &&
          toolCallOutput.update?.messages?.find(
            (message: { type: string }) => message.type === "tool",
          )
        ) {
          toolCallOutput = toolCallOutput.update?.messages?.find(
            (message: { type: string }) => message.type === "tool",
          );
        }

        if (toolCallOutput && toolCallOutput.update?.messages?.length) {
          type MessageFields = ToolMessageFieldsWithToolCallId & {
            type: string;
          };
          toolCallOutput.update?.messages
            .filter((message: MessageFields) => message.type === "tool")
            .forEach((message: MessageFields) => {
              if (!this.activeRun!.hasFunctionStreaming) {
                this.dispatchEvent({
                  type: EventType.TOOL_CALL_START,
                  toolCallId: message.tool_call_id,
                  toolCallName: message.name ?? "",
                  parentMessageId: message.id,
                  rawEvent: event,
                });
                this.dispatchEvent({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: message.tool_call_id,
                  delta: JSON.stringify(event.data.input),
                  rawEvent: event,
                });
              }

              this.dispatchEvent({
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: message.tool_call_id,
                content:
                  typeof message?.content === "string"
                    ? message?.content
                    : JSON.stringify(message?.content),
                messageId: randomUUID(),
                rawEvent: event,
                role: "tool",
              });
            });

          // Tool has completed — reset so the next snapshot reflects real state.
          this.activeRun!.modelMadeToolCall = false;
          this.activeRun!.hasFunctionStreaming = false;
          break;
        }

        // Emit TOOL_CALL_START + ARGS + END for tool calls that were not
        // already handled by the streaming path. Uses emittedToolCallStartIds
        // to avoid duplicates from parallel tool calls.
        if (!this.emittedToolCallStartIds.has(toolCallOutput.tool_call_id)) {
          this.emittedToolCallStartIds.add(toolCallOutput.tool_call_id);
          this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId: toolCallOutput.tool_call_id,
            toolCallName: toolCallOutput.name,
            parentMessageId: toolCallOutput.id,
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: toolCallOutput.tool_call_id,
            delta: JSON.stringify(event.data.input),
            rawEvent: event,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId: toolCallOutput.tool_call_id,
            rawEvent: event,
          });
        }

        const content: string = Array.isArray(toolCallOutput.content)
          ? toolCallOutput.content
              .map((block: any) => {
                if (typeof block === "string") return block;
                if (block.type === "text") return block.text;
                return JSON.stringify(block);
              })
              .join("")
          : toolCallOutput.content;

        this.dispatchEvent({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: toolCallOutput.tool_call_id,
          content,
          messageId: randomUUID(),
          role: "tool",
          rawEvent: event,
        });
        // Tool has completed — reset so the next snapshot reflects real state.
        this.activeRun!.modelMadeToolCall = false;
        this.activeRun!.hasFunctionStreaming = false;
        break;
      case LangGraphEventTypes.OnToolError:
        // A tool threw before OnToolEnd could fire. Without this, the
        // modelMadeToolCall flag would stay set and suppress snapshots
        // for the rest of the run.
        this.activeRun!.modelMadeToolCall = false;
        this.activeRun!.hasFunctionStreaming = false;
        break;
    }
  }

  async handleStreamEventsV3(
      stream: Awaited<
          | ReturnType<typeof this.prepareStream>
          | ReturnType<typeof this.prepareRegenerateStream>
      >,
      threadId: string,
      subscriber: Subscriber<ProcessedEvents>,
      input: RunAgentExtendedInput,
      streamModes: StreamMode | StreamMode[],
  ) {
    // @ts-expect-error -- TODO: fix this
    streamModes = DEFAULT_STREAM_MODES
    const { forwardedProps } = input;
    const nodeNameInput = forwardedProps?.nodeName;
    this.subscriber = subscriber;
    let shouldExit = false;
    if (!stream) return;
    // Reset per-run tracking of emitted tool call IDs
    this.emittedToolCallStartIds = new Set<string>();
    this.emittedInterruptIds = new Set<string>();

    let { streamResponse, state } = stream;

    // Transformer mode: sticky per-run flag. A graph that compiled-in the
    // aguiTransformer emits fully-formed AG-UI events on the `agui`
    // channel; the mux pushes those BEFORE the raw event that triggered
    // them, so the first agui event arrives ahead of any raw event we'd
    // translate. On that first sight we flip into transformer mode and
    // stop translating raw channels — the transformer becomes the single
    // source of truth.
    let transformerMode = false;
    // Step names opened by transformer passthrough STEP_STARTED events and
    // not yet closed by a STEP_FINISHED. The transformer balances these in
    // its finalize(), but those finalize events land AFTER the root
    // terminal lifecycle that watchForRootTerminal uses to end the stream,
    // so they can be cut off. We close any leftover before RUN_FINISHED to
    // satisfy AG-UI verify (no RUN_FINISHED while a step is active).
    const openTransformerSteps = new Set<string>();
    // Set once a RUN_ERROR has been emitted (passthrough or raw `error`).
    // AG-UI verify forbids ANY event after RUN_ERROR, so all post-loop
    // dispatching (step closes, snapshots, RUN_FINISHED) must be skipped.
    let runErrored = false;

    this.activeRun!.prevNodeName = null;
    let latestStateValues = {} as ThreadState<State>["values"];
    let updatedState = state;

    try {
      this.dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun!.id,
      });
      this.handleNodeChange(nodeNameInput);

      for await (let streamResponseChunk of streamResponse) {
        // If a cancel was requested and we haven't sent it yet, try now.
        if (
            this.cancelRequested &&
            !this.cancelSent &&
            this.activeRun?.threadId &&
            this.activeRun?.id
        ) {
          try {
            await this.client.runs.cancel(
                this.activeRun.threadId,
                this.activeRun.id,
            );
          } catch (_) {
            // Ignore cancellation errors
          } finally {
            this.cancelSent = true;
          }
          // Best-effort: ask iterator to close early
          try {
            // Many async iterables used for streaming implement return()
            await (streamResponse as any)?.return?.();
          } catch (_) {}
          break;
        }

        const subgraphsStreamEnabled =
            input.forwardedProps?.streamSubgraphs ?? true;
        const isSubgraphStream =
            subgraphsStreamEnabled && isSubgraphStreamEvent(streamResponseChunk);

        const chunkData = streamResponseChunk.params.data;
        const eventType = streamResponseChunk.method;

        // Transformer passthrough. When the graph compiled-in the
        // `aguiTransformer`, fully-formed AG-UI events arrive on the
        // dedicated `agui` channel. Re-emit them verbatim — no
        // unpacking. This lets the v3 bundle serve both transformer-
        // equipped graphs (passthrough here) and plain graphs
        // (handleSingleEventV3 unpacks the raw `messages` channel below)
        // from one code path. Checked before the streamModes filter
        // because the `agui` channel is not a standard stream mode.
        const passthrough = this.extractAguiPassthroughEvent(eventType, chunkData);
        if (passthrough) {
          transformerMode = true;
          // Track step balance so we can close any the transformer's
          // finalize didn't get to flush before the stream ended.
          if (passthrough.type === EventType.STEP_STARTED) {
            openTransformerSteps.add(passthrough.stepName);
          } else if (passthrough.type === EventType.STEP_FINISHED) {
            openTransformerSteps.delete(passthrough.stepName);
          } else if (passthrough.type === EventType.RUN_ERROR) {
            // Transformer surfaced a fatal run error. After this no further
            // events may be dispatched; suppress all post-loop emission.
            runErrored = true;
          }
          this.dispatchEvent(passthrough);
          continue;
        }

        // Once in transformer mode the transformer is the single source of
        // truth: ignore every raw channel. `error` is exempt — a fatal run
        // error must always surface.
        if (transformerMode && eventType !== "error") {
          continue;
        }

        // @ts-ignore
        if (
            !streamModes.includes(eventType as StreamMode) &&
            !isSubgraphStream &&
            !isMessageTupleEvent(streamResponseChunk) &&
            eventType !== "error"
        ) {
          continue;
        }

        if (eventType === "error") {
          this.dispatchEvent({
            type: EventType.RUN_ERROR,
            message: chunkData.message,
            rawEvent: streamResponseChunk,
          });
          runErrored = true;
          break;
        }

        // Live interrupts. The `tasks` channel carries an `interrupts`
        // array on its create/result/error frames; surface each as a
        // CUSTOM OnInterrupt mid-run. Deduped (shared with the post-run
        // getState scan) so the same interrupt renders once.
        if (eventType === "tasks") {
          const taskInterrupts = (chunkData?.interrupts ?? []) as LangGraphInterrupt[];
          for (const interrupt of taskInterrupts) {
            this.emitInterruptOnce(interrupt);
          }
          continue;
        }

        // Live tool results. The `tools` channel reports tool execution
        // lifecycle; translate completion/error into TOOL_CALL_RESULT so
        // output streams as it lands instead of only appearing in the
        // end-of-run MESSAGES_SNAPSHOT. The call's START/ARGS/END come
        // from the `messages` channel (tool_call content blocks).
        if (eventType === "tools") {
          this.handleToolsEventV3(chunkData as V3ToolsEvent);
          continue;
        }

        if (eventType === "values") {
          latestStateValues = {
            ...latestStateValues,
            ...chunkData,
          };
          continue;
        } else if (
            subgraphsStreamEnabled &&
            eventType.startsWith("values|")
        ) {
          // TODO: deal with subgraphs! on the above line: "eventType.startsWith("values|")"
          latestStateValues = {
            ...latestStateValues,
            ...chunkData,
          };
          continue;
        }

        const currentNodeName = chunkData.graph_name;

        // TODO: figure this out
        // Subgraph detection via langgraph_checkpoint_ns
        // ns format: "" | "node:uuid" | "node:uuid|inner:uuid"
        // const ns: string = metadata.langgraph_checkpoint_ns ?? "";
        // const nsRoot = ns.split("|")[0].split(":")[0];
        // if (ns.includes("|") && nsRoot) this.subgraphs.add(nsRoot);
        // const currentSubgraph =
        //   nsRoot && this.subgraphs.has(nsRoot) ? nsRoot : ROOT_SUBGRAPH_NAME;
        //
        // if (currentSubgraph !== this.currentSubgraph) {
        //   this.currentSubgraph = currentSubgraph;
        //   await this.getStateAndMessagesSnapshots(threadId);
        // }

        // Set server-assigned run id as soon as available
        if (chunkData.run_id) {
          this.activeRun!.id = chunkData.run_id;
          this.activeRun!.serverRunIdKnown = true;
          // If cancel was requested earlier (before server id was known), send it now.
          if (
              this.cancelRequested &&
              !this.cancelSent &&
              this.activeRun?.threadId
          ) {
            try {
              await this.client.runs.cancel(
                  this.activeRun.threadId!,
                  this.activeRun.id,
              );
            } catch (_) {
              // Ignore cancellation errors
            } finally {
              this.cancelSent = true;
            }
          }
        }

        if (currentNodeName && currentNodeName !== this.activeRun!.nodeName) {
          this.handleNodeChange(currentNodeName);
        }

        // Parity with Python reader (langgraph_agent.py:447): update local state
        // cache from on_chain_end outputs so state stays fresh across node boundaries
        // without relying on a `values` stream chunk after every step.
        // LangGraph JS doesn't emit `values` chunks with the latest state between
        // tool execution and run end, so without this update, intermediate
        // STATE_SNAPSHOTs go stale after a tool Command updates state.
        if (
            eventType === 'completed' &&
            this.activeRun!.nodeName === currentNodeName
        ) {
          this.activeRun!.exitingNode = true;
        }
        if (this.activeRun!.exitingNode) {
          // Persist manually-emitted keys into latestStateValues before clearing,
          // so the next STATE_SNAPSHOT (which falls back to latestStateValues)
          // doesn't lose the streamed-in fields if the graph's own values/Command
          // chunk for those fields hasn't landed yet.
          if (
              this.activeRun!.manuallyEmittedState &&
              typeof this.activeRun!.manuallyEmittedState === "object"
          ) {
            latestStateValues = {
              ...latestStateValues,
              ...this.activeRun!.manuallyEmittedState,
            };
          }
          this.activeRun!.manuallyEmittedState = null;
        }

        // we only want to update the node name under certain conditions
        // since we don't need any internal node names to be sent to the frontend
        if (
            this.activeRun!.graphInfo?.["nodes"].some(
                (node) => node.id === currentNodeName,
            )
        ) {
          this.handleNodeChange(currentNodeName);
        }

        updatedState.values =
            this.activeRun!.manuallyEmittedState ?? latestStateValues;

        if (!this.activeRun!.nodeName) {
          continue;
        }

        // TODO: maybe remove
        // const hasStateDiff =
        //   JSON.stringify(updatedState) !== JSON.stringify(state);
        // // Suppress STATE_SNAPSHOT while a message is in progress, or while a
        // // predict_state tool call is streaming args (modelMadeToolCall=true).
        // // During tool arg streaming the graph state does not yet reflect the
        // // forthcoming update, so emitting a snapshot would clobber optimistic
        // // UI state. Flag is cleared in OnToolEnd/OnToolError.
        // //
        // // Diverges from Python: TS blocks ALL snapshot kinds (state-diff,
        // // node change, node exit) while the flag is set; Python only
        // // suppresses on node exit. A post-run snapshot runs the safety net.
        // if (
        //   !this.activeRun!.modelMadeToolCall &&
        //   (hasStateDiff ||
        //     this.activeRun!.prevNodeName != this.activeRun!.nodeName ||
        //     this.activeRun!.exitingNode) &&
        //   !Boolean(this.getMessageInProgress(this.activeRun!.id))
        // ) {
        //   state = updatedState;
        //   this.activeRun!.prevNodeName = this.activeRun!.nodeName;
        //
        //   this.dispatchEvent({
        //     type: EventType.STATE_SNAPSHOT,
        //     snapshot: this.getStateSnapshot(state),
        //     rawEvent: streamResponseChunk,
        //   });
        // }

        this.dispatchEvent({
          type: EventType.RAW,
          event: chunkData,
        });

        // The v3 messages-channel is the only one whose `params.data`
        // matches the V3MessageEvent envelope handleSingleEventV3 expects.
        // Other channels (values/updates/lifecycle/...) carry different
        // shapes and would no-op through the switch anyway — gate here
        // to keep the type contract honest.
        if (eventType === "messages") {
          this.handleSingleEventV3(chunkData as V3MessageEvent);
        }
      }

      // If the run already errored, RUN_ERROR is terminal — AG-UI verify
      // rejects any further event. Skip all post-loop emission (step
      // closes, snapshots, RUN_FINISHED) and just finish the stream.
      if (runErrored) {
        this.cancelRequested = false;
        this.cancelSent = false;
        this.activeRun = undefined;
        return subscriber.complete();
      }

      state = await this.client.threads.getState(threadId);
      const tasks = state.tasks;
      // Collect interrupts from ALL tasks, not just tasks[0] (fixes #1409)
      const interrupts = (tasks ?? []).flatMap(
          (t: any) => t.interrupts ?? [],
      ) as LangGraphInterrupt[];
      const isEndNode = state.next.length === 0;
      const writes = state.metadata?.writes ?? {};

      // Initialize a new node name to use in the next if block
      let newNodeName = this.activeRun!.nodeName!;

      if (!interrupts?.length) {
        newNodeName = isEndNode
            ? "__end__"
            : (state.next[0] ?? Object.keys(writes)[0]);
      }

      // Terminal interrupts (the run paused at interrupt()). Read from the
      // persisted state (channel-independent), deduped against any already
      // surfaced live via the `tasks` channel. Kept even in transformer
      // mode: the dev server reports interrupts on `tasks`, which the
      // transformer does not itself translate, so this is the HITL net.
      interrupts.forEach((interrupt) => this.emitInterruptOnce(interrupt));

      // Canonical snapshots + the final node-step are owned by the client
      // only when translating raw events. In transformer mode the
      // transformer emits STEP_* and STATE/MESSAGES snapshots itself, so
      // skip those. RUN_FINISHED stays — agent.ts owns run lifecycle in
      // both modes.
      if (!transformerMode) {
        this.handleNodeChange(newNodeName);
      }

      // Always close the open client-side step. `handleNodeChange` /
      // `startStep` track the active step ONLY via `activeRun.nodeName`
      // (not openTransformerSteps), and one gets opened by the run-start
      // `handleNodeChange(nodeNameInput)` or a raw node event seen before
      // transformer mode flipped. Without this close it dangles past
      // RUN_FINISHED and AG-UI verify rejects the terminal event.
      this.handleNodeChange(undefined);

      // Emit the canonical STATE/MESSAGES snapshot from the server's
      // persisted state at run end — in BOTH modes. This runs after every
      // transformer event is consumed, so it's the last snapshot and wins
      // (MESSAGES_SNAPSHOT is a full replace by id). It reconciles the
      // frontend history to authoritative server state, which matters in
      // transformer mode because the transformer's own MESSAGES_SNAPSHOT
      // can drop an assistant's tool_calls linkage — the next turn would
      // then send OpenAI an orphan `tool` message and get a 400.
      await this.getStateAndMessagesSnapshots(threadId);

      // Also close any transformer-emitted step whose finalize
      // STEP_FINISHED was cut off when the stream ended on the root
      // terminal (these are tracked from passthrough STEP_* events).
      if (transformerMode) {
        for (const stepName of openTransformerSteps) {
          this.dispatchEvent({ type: EventType.STEP_FINISHED, stepName });
        }
        openTransformerSteps.clear();
      }

      this.dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: this.activeRun!.id,
      });
      // Reset cancel flags when run completes
      this.cancelRequested = false;
      this.cancelSent = false;
      this.activeRun = undefined;
      return subscriber.complete();
    } catch (e) {
      return subscriber.error(e);
    } finally {
      // Per-run cleanup hook lives on the preparedStream (e.g.
      // unsubscribe from the cached ThreadStream's lifecycle watcher).
      // Best-effort — the cached thread + sub themselves live on for
      // the next request on this threadId.
      const closer = (stream as { close?: () => void | Promise<void> } | undefined)?.close;
      if (typeof closer === "function") {
        try {
          await closer();
        } catch (_) {
          // swallow — close is best-effort cleanup
        }
      }
    }
  }

  /**
   * Detect and unwrap a transformer passthrough event off the v3 stream.
   *
   * When a graph registers the `aguiTransformer` at compile time, it
   * pushes fully-formed AG-UI events onto a dedicated `agui` stream
   * channel. Those surface two ways depending on transport:
   *  - In-process: the mux forwards each push as a protocol event whose
   *    `method` is the channel name (`"agui"`) and whose `params.data`
   *    is the AG-UI event itself.
   *  - Remote SDK wire: a named custom channel surfaces as `method:
   *    "custom"` with the channel identity on `params.data`
   *    (`name`/`type` === `"agui"`) and the AG-UI event carried inline
   *    or under `payload`.
   *
   * Returns the AG-UI event ready to re-dispatch, or undefined when the
   * chunk is not an agui-channel passthrough.
   */
  private extractAguiPassthroughEvent(
    eventType: string,
    chunkData: unknown,
  ): ProcessedEvents | undefined {
    const asEvent = (candidate: unknown): ProcessedEvents | undefined => {
      if (
        candidate != null &&
        typeof candidate === "object" &&
        "type" in candidate &&
        typeof (candidate as { type: unknown }).type === "string" &&
        // Guard against treating the channel wrapper (type === "agui")
        // as if it were an AG-UI event.
        (candidate as { type: string }).type !== "agui"
      ) {
        return candidate as ProcessedEvents;
      }
      return undefined;
    };

    if (eventType === "agui") return asEvent(chunkData);

    if (
      eventType === "custom" &&
      chunkData != null &&
      typeof chunkData === "object"
    ) {
      const wrapper = chunkData as {
        name?: unknown;
        type?: unknown;
        payload?: unknown;
      };
      if (wrapper.name === "agui" || wrapper.type === "agui") {
        return asEvent(wrapper.payload) ?? asEvent(chunkData);
      }
    }

    return undefined;
  }

  /**
   * Surface an interrupt as a CUSTOM OnInterrupt exactly once per run.
   * Deduped by interrupt id, falling back to a hash of the value when the
   * server omits an id. Shared between the live `tasks` channel and the
   * post-run threads.getState() scan so a single interrupt — whether seen
   * mid-run, at run end, or both — renders one prompt.
   */
  private emitInterruptOnce(interrupt: LangGraphInterrupt): void {
    const key = interrupt.id ?? `v:${JSON.stringify(interrupt.value ?? null)}`;
    if (this.emittedInterruptIds.has(key)) return;
    this.emittedInterruptIds.add(key);
    this.dispatchEvent({
      type: EventType.CUSTOM,
      name: LangGraphEventTypes.OnInterrupt,
      value:
        typeof interrupt.value === "string"
          ? interrupt.value
          : JSON.stringify(interrupt.value),
      rawEvent: interrupt,
    });
  }

  /**
   * Translate a v3 `tools`-channel event into an AG-UI TOOL_CALL_RESULT.
   *
   * The tool call's START / ARGS / END already flow from the `messages`
   * channel (tool_call content blocks), and AG-UI has no incremental
   * tool-result event, so we emit a single TOOL_CALL_RESULT when the tool
   * finishes (or carry its error message through on failure).
   * `tool-started` / `tool-output-delta` need no AG-UI counterpart.
   */
  private handleToolsEventV3(data: V3ToolsEvent | undefined): void {
    if (!data) return;
    if (data.event === "tool-finished") {
      this.dispatchEvent({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: data.tool_call_id,
        content:
          typeof data.output === "string"
            ? data.output
            : JSON.stringify(data.output ?? ""),
        messageId: randomUUID(),
        role: "tool",
      });
    } else if (data.event === "tool-error") {
      this.dispatchEvent({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: data.tool_call_id,
        content: data.message ?? "Tool error",
        messageId: randomUUID(),
        role: "tool",
      });
    }
  }

  handleSingleEventV3(data: V3MessageEvent | undefined): void {
    // Receives the inner `params.data` of a v3 `messages`-channel event.
    // Shape and switch mirror the server-side aguiTransformer's
    // `case "messages"` block, but dispatch via `this.dispatchEvent`
    // instead of pushing onto a StreamChannel.
    //
    // Per-content-block tracking lives on `this.activeRun` so it
    // resets cleanly between runs (runAgentStream replaces activeRun
    // wholesale).
    if (!data) return;
    const run = this.activeRun;
    if (!run) return;

    switch (data.event) {
      case "message-start": {
        // The protocol declares `role` on MessageStartData but the
        // langgraph dev server omits it in practice. Use any
        // message-start as the signal to bind activeMessageId; the
        // content-block-start filter (type === "text" etc.) ensures
        // we only emit AG-UI events for blocks we recognise.
        if (!data.id) break;
        run.activeMessageId = data.id;
        break;
      }

      case "content-block-start": {
        if (data.index == null) break;
        const blockType = data.content?.type;
        if (blockType === "text") {
          if (!run.activeMessageId) break;
          run.textBlockMessageIds.set(data.index, run.activeMessageId);
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_START,
            messageId: run.activeMessageId,
            role: "assistant",
          });
        } else if (blockType === "reasoning" || blockType === "thinking") {
          // Standardized v3 `reasoning` plus the older
          // langchain-anthropic `thinking` alias. One reasoning
          // entity scoped to (activeMessageId, content-block index).
          if (!run.activeMessageId) break;
          const reasoningId = `${run.activeMessageId}:r:${data.index}`;
          run.reasoningBlocks.set(data.index, {
            messageId: reasoningId,
            messageStarted: false,
          });
          this.dispatchEvent({
            type: EventType.REASONING_START,
            messageId: reasoningId,
          });
          const block = data.content;
          const initial = block?.reasoning ?? block?.thinking ?? "";
          if (initial.length > 0) {
            this.dispatchEvent({
              type: EventType.REASONING_MESSAGE_START,
              messageId: reasoningId,
              role: "reasoning",
            });
            run.reasoningBlocks.get(data.index)!.messageStarted = true;
            this.dispatchEvent({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: reasoningId,
              delta: initial,
            });
          }
          if (block?.signature) {
            this.dispatchEvent({
              type: EventType.REASONING_ENCRYPTED_VALUE,
              subtype: "message",
              entityId: reasoningId,
              encryptedValue: block.signature,
            });
          }
        } else if (blockType === "redacted_thinking") {
          // Anthropic redacted_thinking: opaque encrypted CoT.
          // Surface as a standalone REASONING_ENCRYPTED_VALUE without
          // opening a visible reasoning message.
          const block = data.content;
          if (run.activeMessageId && block?.data) {
            this.dispatchEvent({
              type: EventType.REASONING_ENCRYPTED_VALUE,
              subtype: "message",
              entityId: run.activeMessageId,
              encryptedValue: block.data,
            });
          }
        } else if (blockType === "tool_call_chunk" || blockType === "tool_call") {
          const block = data.content;
          const toolCallId = block?.id ?? `tc-${data.index}`;
          const toolCallName = block?.name ?? "";
          const initialArgs = typeof block?.args === "string" ? block.args : "";
          run.toolBlocks.set(data.index, {
            toolCallId,
            toolCallName,
            argsSoFar: initialArgs,
          });
          this.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName,
            parentMessageId: run.activeMessageId,
          });
          if (initialArgs.length > 0) {
            this.dispatchEvent({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: initialArgs,
            });
          }
        }
        break;
      }

      case "content-block-delta": {
        if (data.index == null) break;
        const deltaType = data.delta?.type;
        if (deltaType === "text-delta") {
          // Server may emit text deltas at a content-block index
          // already occupied by another type (e.g. reasoning at idx=0,
          // then text deltas at idx=0 with no preceding text
          // content-block-start). Treat that as implicit open: mint a
          // TEXT_MESSAGE_START on first delta. End is taken care of
          // on message-finish.
          let messageId: string | undefined = run.textBlockMessageIds.get(data.index);
          if (!messageId && run.activeMessageId) {
            messageId = run.activeMessageId;
            run.textBlockMessageIds.set(data.index, messageId);
            this.dispatchEvent({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            });
          }
          if (!messageId) break;
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: data.delta?.text ?? "",
          });
        } else if (deltaType === "reasoning-delta" || deltaType === "thinking-delta") {
          const r = run.reasoningBlocks.get(data.index);
          if (!r) break;
          const text: string =
            data.delta?.reasoning ?? data.delta?.thinking ?? "";
          if (text.length === 0) break;
          if (!r.messageStarted) {
            this.dispatchEvent({
              type: EventType.REASONING_MESSAGE_START,
              messageId: r.messageId,
              role: "reasoning",
            });
            r.messageStarted = true;
          }
          this.dispatchEvent({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: r.messageId,
            delta: text,
          });
        } else if (deltaType === "block-delta") {
          // BlockDelta shallow-merge fields. For tool calls, `args` is
          // the FULL cumulative JSON string, not an incremental piece.
          // AG-UI's TOOL_CALL_ARGS expects a delta — diff against the
          // prefix already sent.
          const tool = run.toolBlocks.get(data.index);
          if (!tool) break;
          const fields = data.delta?.fields;
          if (fields?.name && !tool.toolCallName) tool.toolCallName = fields.name;
          if (typeof fields?.args === "string") {
            const cumulative: string = fields.args;
            if (cumulative.startsWith(tool.argsSoFar)) {
              const delta = cumulative.slice(tool.argsSoFar.length);
              tool.argsSoFar = cumulative;
              if (delta.length > 0) {
                this.dispatchEvent({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: tool.toolCallId,
                  delta,
                });
              }
            } else {
              // Engine replaced the buffer (e.g. arg correction).
              // Ship the full new string as one delta and reset.
              tool.argsSoFar = cumulative;
              this.dispatchEvent({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: tool.toolCallId,
                delta: cumulative,
              });
            }
          }
        }
        break;
      }

      case "content-block-finish": {
        if (data.index == null) break;
        // Dispatch by the FINISHING block's type, not by
        // tracker-presence. Text and reasoning can share a content
        // index (server emits text deltas at the same idx as a
        // reasoning block); inferring from "first map that has this
        // index" sends the wrong END event.
        const finishType = data.content?.type;
        if (finishType === "text") {
          const messageId = run.textBlockMessageIds.get(data.index);
          if (messageId) {
            this.dispatchEvent({ type: EventType.TEXT_MESSAGE_END, messageId });
            run.textBlockMessageIds.delete(data.index);
          }
        } else if (finishType === "reasoning" || finishType === "thinking") {
          const r = run.reasoningBlocks.get(data.index);
          if (r) {
            if (r.messageStarted) {
              this.dispatchEvent({
                type: EventType.REASONING_MESSAGE_END,
                messageId: r.messageId,
              });
            }
            this.dispatchEvent({
              type: EventType.REASONING_END,
              messageId: r.messageId,
            });
            run.reasoningBlocks.delete(data.index);
          }
        } else if (finishType === "tool_call_chunk" || finishType === "tool_call") {
          const tool = run.toolBlocks.get(data.index);
          if (tool) {
            this.dispatchEvent({
              type: EventType.TOOL_CALL_END,
              toolCallId: tool.toolCallId,
            });
            run.toolBlocks.delete(data.index);
          }
        }
        break;
      }

      case "message-finish": {
        // Close any text blocks still open on this message. The server
        // omits content-block-finish for implicitly-opened text blocks
        // (text deltas reusing a reasoning block's index), so flush
        // them here.
        for (const [index, messageId] of run.textBlockMessageIds) {
          this.dispatchEvent({ type: EventType.TEXT_MESSAGE_END, messageId });
          run.textBlockMessageIds.delete(index);
        }
        run.activeMessageId = undefined;
        break;
      }

      case "message-error": {
        run.activeMessageId = undefined;
        run.textBlockMessageIds.clear();
        break;
      }
    }
  }

  private async getStateAndMessagesSnapshots(threadId: string): Promise<void> {
    const state: ThreadState<State> =
        await this.client.threads.getState(threadId);
    this.dispatchEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: this.getStateSnapshot(state),
    });
    const checkpointMessages: LangGraphMessage[] =
        (state.values as State).messages ?? [];
    this.dispatchEvent({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: langchainMessagesToAgui(checkpointMessages),
    });
  }

  /**
   * Process [AIMessageChunk, metadata] tuples from messages-tuple stream mode
   * and convert them into AG-UI text message and tool call events.
   * Uses the same messagesInProcess tracking as events-mode streaming.
   *
   * This is a legacy fallback for LangGraph Platform deployments that do not emit
   * on_chat_model_stream events (older streaming modes). It is only called when
   * eventsStreamActive is false — i.e. no events-mode streaming has been seen yet.
   * Do not remove: required for backward compatibility with older LangGraph Platform.
   */
  private handleMessagesTupleEvent(data: any[]) {
    const chunk = data[0];

    // Skip non-AI chunks (e.g., tool result messages, human messages)
    if (chunk.type && chunk.type !== "AIMessageChunk") return;

    const content =
      typeof chunk.content === "string"
        ? chunk.content
        : Array.isArray(chunk.content)
          ? chunk.content.find((c: any) => c.type === "text")?.text
          : null;
    const toolCallChunks = chunk.tool_call_chunks;
    const isFinished = chunk.response_metadata?.finish_reason === "stop";
    const currentStream = this.getMessageInProgress(this.activeRun!.id);

    // Handle tool call chunks
    if (toolCallChunks?.length > 0) {
      const tc = toolCallChunks[0];
      if (tc.name) {
        // End any text message in progress
        if (currentStream?.id && !currentStream?.toolCallId) {
          this.dispatchEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentStream.id,
          });
          this.messagesInProcess[this.activeRun!.id] = null;
        }
        // Start new tool call
        this.dispatchEvent({
          type: EventType.TOOL_CALL_START,
          toolCallId: tc.id || chunk.id,
          toolCallName: tc.name,
          parentMessageId: chunk.id,
        });
        this.setMessageInProgress(this.activeRun!.id, {
          id: chunk.id,
          toolCallId: tc.id || chunk.id,
          toolCallName: tc.name,
        });
        this.activeRun!.hasFunctionStreaming = true;
      } else if (tc.args && currentStream?.toolCallId) {
        this.dispatchEvent({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: currentStream.toolCallId,
          delta: tc.args,
        });
      }
      return;
    }

    // Handle finish
    if (isFinished) {
      if (currentStream?.toolCallId) {
        this.dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId: currentStream.toolCallId,
        });
      } else if (currentStream?.id) {
        this.dispatchEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentStream.id,
        });
      }
      this.messagesInProcess[this.activeRun!.id] = null;
      return;
    }

    // Skip empty initialization chunks
    if (!content && !toolCallChunks?.length) return;

    // Handle text content streaming
    if (content) {
      if (!currentStream) {
        const messageId = this.getOrPinTextMessageId(chunk.id);
        this.dispatchEvent({
          type: EventType.TEXT_MESSAGE_START,
          role: "assistant",
          messageId,
        });
        this.setMessageInProgress(this.activeRun!.id, {
          id: messageId,
          toolCallId: null,
          toolCallName: null,
        });
      }
      this.dispatchEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: (
          this.getMessageInProgress(this.activeRun!.id) ?? { id: chunk.id }
        ).id,
        delta: content,
      });
    }
  }

  protected interruptsToAGUI(
    list: readonly LangGraphInterrupt[],
  ): AGUIInterrupt[] {
    return langGraphInterruptsToAGUI(list);
  }

  protected buildCommandResumeFromAgui(
    entries: readonly ResumeEntry[],
    _ctx: { openInterrupts: AGUIInterrupt[] },
  ): unknown {
    return buildLgCommandResumeFromAgui(entries);
  }

  // Request cancellation of the current run via LangGraph Platform SDK
  public abortRun() {
    this.cancelRequested = true;
    const threadId = this.activeRun?.threadId;
    const runId = this.activeRun?.id;
    if (threadId && runId && !this.cancelSent) {
      void this.client.runs
        .cancel(threadId, runId)
        .then(() => {
          this.cancelSent = true;
        })
        .catch(() => {
          // Ignore cancellation errors; streaming loop will also check cancelRequested
        });
    }
    super.abortRun();
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      identity: { type: "langgraph" },
      humanInTheLoop: {
        supported: true,
        interrupts: true,
        approveWithEdits: true,
      },
      state: { snapshots: true, deltas: false, persistentState: true },
      transport: { streaming: true },
    };
  }

  handleReasoningEvent(reasoningData: LangGraphReasoning) {
    if (!reasoningData || !reasoningData.type) {
      return;
    }

    // A text-less chunk is still meaningful when it carries the provider's
    // canonical reasoning id (the `response.output_item.added` /
    // `…summary_part.added` chunks): stash the id so the first text delta
    // opens the reasoning message under it, WITHOUT opening a message here —
    // a summary-less (store=true) reasoning item must keep rendering nothing.
    if (!reasoningData.text) {
      if (reasoningData.id) {
        this.pendingReasoningId = reasoningData.id;
      }
      return;
    }

    const reasoningStepIndex = reasoningData.index;

    if (
      this.reasoningProcess?.index &&
      this.reasoningProcess.index !== reasoningStepIndex
    ) {
      if (this.reasoningProcess.type) {
        this.dispatchEvent({
          type: EventType.REASONING_MESSAGE_END,
          messageId: this.reasoningProcess.messageId,
        });
      }
      this.dispatchEvent({
        type: EventType.REASONING_END,
        messageId: this.reasoningProcess.messageId,
      });
      this.reasoningProcess = null;
    }

    if (!this.reasoningProcess) {
      // No thinking step yet. Start a new one. Prefer the provider's
      // canonical reasoning id (e.g. OpenAI `rs_…`) when the stream carried
      // one: the snapshot converter re-emits this same reasoning under that
      // id, and only a matching id lets the client reconcile the streamed
      // copy with the snapshot copy instead of rendering both.
      const messageId = reasoningData.id ?? this.pendingReasoningId ?? randomUUID();
      this.pendingReasoningId = undefined;
      this.dispatchEvent({
        type: EventType.REASONING_START,
        messageId,
      });
      this.reasoningProcess = {
        index: reasoningStepIndex,
        messageId,
      };
    }

    if (this.reasoningProcess.type !== reasoningData.type) {
      this.dispatchEvent({
        type: EventType.REASONING_MESSAGE_START,
        messageId: this.reasoningProcess.messageId,
        role: "reasoning" as const,
      });
      this.reasoningProcess.type = reasoningData.type;
    }

    // Accumulate signature if present (Anthropic extended thinking)
    if (reasoningData.signature) {
      this.reasoningProcess.signature = reasoningData.signature;
    }

    if (this.reasoningProcess.type) {
      this.dispatchEvent({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: this.reasoningProcess.messageId,
        delta: reasoningData.text,
      });
    }
  }

  getStateSnapshot(threadState: ThreadState<State>) {
    let state = threadState.values;
    const schemaKeys = this.activeRun!.schemaKeys!;
    // Do not emit state keys that are not part of the output schema
    if (schemaKeys?.output) {
      state = filterObjectBySchemaKeys(state, [
        ...this.constantSchemaKeys,
        ...schemaKeys.output,
      ]);
    }
    // return state
    return state;
  }

  async getOrCreateThread(
    threadId: string,
    threadMetadata?: Record<string, any>,
  ): Promise<Thread> {
    let thread: Thread;
    try {
      try {
        thread = await this.getThread(threadId);
      } catch (error) {
        thread = await this.createThread({
          threadId,
          metadata: threadMetadata,
        });
      }
    } catch (error: unknown) {
      throw new Error(`Failed to create thread: ${(error as Error).message}`);
    }

    return thread;
  }

  async getThread(threadId: string) {
    return this.client.threads.get(threadId);
  }

  async createThread(
    payload?: Parameters<typeof this.client.threads.create>[0],
  ) {
    return this.client.threads.create(payload);
  }

  async mergeConfigs({
    configs,
    assistant,
    schemaKeys,
  }: {
    configs: Config[];
    assistant: Assistant;
    schemaKeys: SchemaKeys;
  }) {
    return configs.reduce((acc, cfg) => {
      let filteredConfigurable = acc.configurable;

      if (cfg.configurable) {
        filteredConfigurable = schemaKeys?.config
          ? filterObjectBySchemaKeys(cfg?.configurable, [
              ...this.constantSchemaKeys,
              ...(schemaKeys?.config ?? []),
              ...(schemaKeys?.context ?? []),
            ])
          : cfg?.configurable;
      }

      const newConfig = {
        ...acc,
        ...cfg,
        configurable: filteredConfigurable,
      };

      // LG does not return recursion limit if it's the default, therefore we check: if no recursion limit is currently set, and the user asked for 25, there is no change.
      const isRecursionLimitSetToDefault =
        acc.recursion_limit == null && cfg.recursion_limit === 25;
      // Deep compare configs to avoid unnecessary update calls
      const configsAreDifferent =
        JSON.stringify(newConfig) !== JSON.stringify(acc);

      // Check if the only difference is the recursion_limit being set to default
      const isOnlyRecursionLimitDifferent =
        isRecursionLimitSetToDefault &&
        JSON.stringify({ ...newConfig, recursion_limit: null }) ===
          JSON.stringify({ ...acc, recursion_limit: null });

      if (configsAreDifferent && !isOnlyRecursionLimitDifferent) {
        return {
          ...acc,
          ...newConfig,
        };
      }

      return acc;
    }, assistant.config);
  }

  getMessageInProgress(runId: string) {
    return this.messagesInProcess[runId];
  }

  setMessageInProgress(runId: string, data: MessageInProgress) {
    this.messagesInProcess = {
      ...this.messagesInProcess,
      [runId]: {
        ...(this.messagesInProcess[runId] as MessageInProgress),
        ...data,
      },
    };
  }

  async getAssistant(): Promise<Assistant> {
    try {
      const assistants = await this.client.assistants.search({
        graphId: this.graphId,
        limit: 1,
      });
      const retrievedAssistant = assistants.find(
        (searchResult) => searchResult.graph_id === this.graphId,
      );
      if (!retrievedAssistant) {
        const notFoundMessage = `
      No agent found with graph ID ${this.graphId} found..\n

      These are the available agents: [${assistants.map((a) => `${a.graph_id} (ID: ${a.assistant_id})`).join(", ")}]
      `;
        console.error(notFoundMessage);
        throw new Error(notFoundMessage);
      }

      return retrievedAssistant;
    } catch (error) {
      const redefinedError = new Error(
        `Failed to retrieve assistant: ${(error as Error).message}`,
      );
      this.dispatchEvent({
        type: EventType.RUN_ERROR,
        message: redefinedError.message,
      });
      this.subscriber.error();
      throw redefinedError;
    }
  }

  async getSchemaKeys(): Promise<SchemaKeys> {
    try {
      const graphSchema = await this.client.assistants.getSchemas(
        this.assistant!.assistant_id,
      );
      let configSchema = null;
      let contextSchema: string[] = [];
      if (
        "context_schema" in graphSchema &&
        graphSchema.context_schema?.properties
      ) {
        contextSchema = Object.keys(graphSchema.context_schema.properties);
      }
      if (graphSchema.config_schema?.properties) {
        configSchema = Object.keys(graphSchema.config_schema.properties);
      }
      if (
        !graphSchema.input_schema?.properties ||
        !graphSchema.output_schema?.properties
      ) {
        return {
          config: [],
          input: null,
          output: null,
          context: contextSchema,
        };
      }
      const inputSchema = Object.keys(graphSchema.input_schema.properties);
      const outputSchema = Object.keys(graphSchema.output_schema.properties);

      return {
        input:
          inputSchema && inputSchema.length
            ? [...inputSchema, ...this.constantSchemaKeys]
            : null,
        output:
          outputSchema && outputSchema.length
            ? [...outputSchema, ...this.constantSchemaKeys]
            : null,
        context: contextSchema,
        config: configSchema,
      };
    } catch (e) {
      return {
        config: [],
        input: this.constantSchemaKeys,
        output: this.constantSchemaKeys,
        context: [],
      };
    }
  }

  langGraphDefaultMergeState(
    state: State,
    messages: LangGraphMessage[],
    input: RunAgentExtendedInput,
  ): State<StateEnrichment> {
    if (
      messages.length > 0 &&
      "role" in messages[0] &&
      messages[0].role === "system"
    ) {
      // remove system message
      messages = messages.slice(1);
    }

    // merge with existing messages
    const existingMessages: LangGraphPlatformMessage[] = state.messages || [];
    const existingMessageIds = new Set(
      existingMessages.map((message) => message.id),
    );

    const newMessages = messages.filter(
      (message) => !existingMessageIds.has(message.id),
    );

    // Input tools first so they win over stale state tools on name collision
    const langGraphTools: LangGraphToolWithName[] = [
      ...(input.tools ?? []),
      ...(state.tools ?? []),
    ].reduce((acc, tool) => {
      let mappedTool = tool;
      if (!tool.type) {
        mappedTool = {
          type: "function",
          name: tool.name,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        };
      }

      // Verify no duplicated
      if (
        acc.find(
          (t: LangGraphToolWithName) =>
            t.name === mappedTool.name ||
            t.function.name === mappedTool.function.name,
        )
      )
        return acc;

      return [...acc, mappedTool];
    }, []);

    // Surface the A2UI tool-injection flag (set by the A2UI middleware via
    // forwardedProps.injectA2UITool) into ag-ui state so graphs/tools can read
    // it directly from state regardless of run mode. TS forwardedProps keys are
    // not snake-cased, so the original camelCase key is used as-is.
    const injectA2UITool = input.forwardedProps?.injectA2UITool;
    const agUiState: StateEnrichment["ag-ui"] = {
      tools: langGraphTools,
      context: input.context,
    };
    if (injectA2UITool !== undefined) {
      agUiState.inject_a2ui_tool = injectA2UITool;
    }

    return {
      ...state,
      messages: newMessages,
      tools: langGraphTools,
      "ag-ui": agUiState,
      copilotkit: {
        ...(state as any).copilotkit,
        actions: langGraphTools,
      },
    };
  }

  handleNodeChange(nodeName: string | undefined) {
    if (nodeName === "__end__") {
      nodeName = undefined;
    }
    if (nodeName !== this.activeRun?.nodeName) {
      // End current step
      if (this.activeRun?.nodeName) {
        this.endStep();
      }
      // If we actually got a node name, start a new step
      if (nodeName) {
        this.startStep(nodeName);
      }
      // Clear the pinned text message id: a new node should mint its own
      // bubble. See RunMetadata.currentTextMessageId.
      if (this.activeRun) {
        this.activeRun.currentTextMessageId = undefined;
      }
    }
    this.activeRun!.nodeName = nodeName;
  }

  /**
   * Returns the messageId to use for a TEXT_MESSAGE_START emission, pinning
   * the first id per node. chunk.id changes per LLM invocation, so a
   * text→tool→text sequence within one node would otherwise render as
   * multiple bubbles; pinning keeps them in one. handleNodeChange clears
   * the pin on every node transition, so different nodes (e.g. a supervisor
   * routing to specialist agents) get fresh ids and stay in separate
   * bubbles. See #1317.
   */
  private getOrPinTextMessageId(fallbackId: string): string {
    const messageId =
      this.activeRun!.currentTextMessageId ?? fallbackId;
    this.activeRun!.currentTextMessageId = messageId;
    return messageId;
  }

  startStep(nodeName: string) {
    this.dispatchEvent({
      type: EventType.STEP_STARTED,
      stepName: nodeName,
    });
  }

  endStep() {
    this.dispatchEvent({
      type: EventType.STEP_FINISHED,
      stepName: this.activeRun!.nodeName!,
    });
  }

  async getCheckpointByMessage(
    messageId: string,
    threadId: string,
    checkpoint?: null | {
      checkpoint_id?: null | string;
      checkpoint_ns: string;
    },
  ): Promise<ThreadState> {
    const options = checkpoint?.checkpoint_id
      ? {
          checkpoint: { checkpoint_id: checkpoint.checkpoint_id },
        }
      : undefined;
    const history = await this.client.threads.getHistory(threadId, options);
    const reversed = [...history].reverse(); // oldest → newest

    let targetState = reversed.find((state) =>
      (state.values as State).messages?.some(
        (m: LangGraphPlatformMessage) => m.id === messageId,
      ),
    );

    if (!targetState) throw new Error("Message not found");

    const targetStateMessages = (targetState.values as State).messages ?? [];
    const messageIndex = targetStateMessages.findIndex(
      (m: LangGraphPlatformMessage) => m.id === messageId,
    );
    const messagesAfter = targetStateMessages.slice(messageIndex + 1);
    if (messagesAfter.length) {
      return this.getCheckpointByMessage(
        messageId,
        threadId,
        targetState.parent_checkpoint,
      );
    }

    const targetStateIndex = reversed.indexOf(targetState);

    const { messages, ...targetStateValuesWithoutMessages } =
      targetState.values as State;
    const selectedCheckpoint = reversed[targetStateIndex - 1] ?? {
      ...targetState,
      values: {},
    };
    return {
      ...selectedCheckpoint,
      values: {
        ...selectedCheckpoint.values,
        ...targetStateValuesWithoutMessages,
      },
    };
  }
}

export * from "./types";
