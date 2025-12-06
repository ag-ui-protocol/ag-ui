import { AbstractAgent, EventType, randomUUID } from "@ag-ui/client";
import type {
  AgentConfig,
  BaseEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateSnapshotEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import type { A2AClient } from "@a2a-js/sdk/client";
import type {
  MessageSendConfiguration,
  MessageSendParams,
  Message as A2AMessage,
  JSONRPCResponse,
} from "@a2a-js/sdk";
import {
  convertAGUIMessagesToA2A,
  convertA2AEventToAGUIEvents,
  createSharedStateTracker,
  ENGRAM_EXTENSION_URI,
  DEFAULT_ARTIFACT_BASE_PATH,
} from "./utils";
import type {
  A2AAgentRunResultSummary,
  ConvertedA2AMessages,
  A2AStreamEvent,
  SurfaceTracker,
  A2ARunOptions,
  ConvertA2AEventOptions,
  EngramConfig,
  EngramGetParams,
  EngramGetResult,
  EngramListParams,
  EngramListResult,
  EngramSetParams,
  EngramSetResult,
  EngramPatchParams,
  EngramPatchResult,
  EngramDeleteParams,
  EngramDeleteResult,
  EngramSubscribeParams,
  EngramSubscribeResult,
  EngramSubscriptionOptions,
  EngramEvent,
  EngramRequestOptions,
  EngramRecord,
  EngramKey,
} from "./types";

export interface A2AAgentConfig extends AgentConfig {
  a2aClient: A2AClient;
  runOptions?: Partial<A2ARunOptions>;
  engram?: EngramConfig;
}

type EngramRunMode = "hydrate_stream" | "hydrate_once" | "sync";

type EngramForwardedProps = {
  engram?: {
    mode?: EngramRunMode;
    filter?: { keyPrefix?: string; key?: EngramKey };
    [key: string]: unknown;
  };
};

type A2ARunInput = Omit<RunAgentInput, "forwardedProps"> & {
  forwardedProps?: { a2a?: A2ARunOptions } & EngramForwardedProps & Record<string, unknown>;
};

type ResolvedA2ARunOptions = Required<
  Pick<
    A2ARunOptions,
    | "mode"
    | "acceptedOutputModes"
    | "includeToolMessages"
    | "includeSystemMessages"
    | "includeDeveloperMessages"
    | "artifactBasePath"
    | "subscribeOnly"
  >
> &
  A2ARunOptions & { contextId?: string; engramEnabled: boolean; engramExtensionUri: string };

export class A2AAgent extends AbstractAgent {
  private readonly a2aClient: A2AClient;
  private readonly messageIdMap = new Map<string, string>();
  private readonly defaultRunOptions: Partial<A2ARunOptions>;
  private readonly defaultEngramEnabled: boolean;
  private readonly defaultEngramExtensionUri: string;
  private engramRuntimeEnabled = false;
  private engramRuntimeExtensionUri: string;
  private forceEngramHeader = false;
  private engramSupportChecked = false;
  private hasBoundContextId = false;

  constructor(config: A2AAgentConfig) {
    const { a2aClient, runOptions, engram, ...rest } = config;
    if (!a2aClient) {
      throw new Error("A2AAgent requires a configured A2AClient instance.");
    }

    super({ ...rest, deferThreadId: true });

    this.a2aClient = a2aClient;
    this.defaultRunOptions = runOptions ?? {};
    this.defaultEngramEnabled = engram?.enabled ?? false;
    this.defaultEngramExtensionUri = engram?.extensionUri ?? ENGRAM_EXTENSION_URI;
    this.engramRuntimeEnabled = this.defaultEngramEnabled;
    this.engramRuntimeExtensionUri = this.defaultEngramExtensionUri;
    this.initializeExtension(this.a2aClient);
  }

  clone() {
    return new A2AAgent({
      a2aClient: this.a2aClient,
      debug: this.debug,
      runOptions: this.defaultRunOptions,
      engram: {
        enabled: this.defaultEngramEnabled,
        extensionUri: this.defaultEngramExtensionUri,
      },
    });
  }

  public override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
      const typedInput = input as A2ARunInput;
      let emitRunStarted: () => void = () => {};
      let flushPendingEvents: () => void = () => {};
      let boundContextId: string | undefined;
      let contextBound = false;
      let runStartedEmitted = false;
      let runFinishedFromEvents = false;
      const pendingEvents: BaseEvent[] = [];

      const normalizeId = (value?: string | null): string | undefined => {
        const trimmed = value?.toString().trim();
        return trimmed && trimmed.length > 0 ? trimmed : undefined;
      };
      const resolveThreadIdForRun = (): string =>
        normalizeId(boundContextId) ??
        normalizeId(this.threadId) ??
        normalizeId(input.threadId) ??
        input.runId;

      try {
        const forwardedEngram = (typedInput.forwardedProps as EngramForwardedProps | undefined)?.engram;
        if (forwardedEngram) {
          if (!forwardedEngram.mode) {
            throw new Error("Engram run requested without a mode. Provide forwardedProps.engram.mode.");
          }
          await this.withEngramContext(
            this.defaultEngramEnabled,
            this.defaultEngramExtensionUri,
            async () => {
              await this.ensureEngramSupport(this.defaultEngramExtensionUri);
              await this.handleEngramRun(forwardedEngram, typedInput, subscriber, resolveThreadIdForRun());
            },
            { forceHeader: true },
          );
          return;
        }

        let runOptions = this.resolveRunOptions(typedInput);
        await this.withEngramContext(
          runOptions.engramEnabled,
          runOptions.engramExtensionUri,
          async () => {
            await this.ensureEngramSupportIfEnabled(runOptions);

            const converted = this.prepareConversation(typedInput, runOptions);
            const hasOutgoingMessage = Boolean(converted.targetMessage ?? converted.latestUserMessage);
            const subscribeOnly =
              runOptions.mode !== "send" &&
              (runOptions.subscribeOnly || (!hasOutgoingMessage && Boolean(runOptions.taskId)));
            runOptions = { ...runOptions, subscribeOnly };
            const targetMessage =
              converted.targetMessage ??
              converted.latestUserMessage ??
              converted.history[converted.history.length - 1];

            this.messageIdMap.clear();
            const aggregatedText = new Map<string, string>();
            const surfaceTracker = this.createSurfaceTracker();
            const sharedStateTracker = createSharedStateTracker();
            const rawEvents: A2AStreamEvent[] = [];

        const normalizedContextId = runOptions.contextId?.trim();
        boundContextId =
          normalizedContextId && normalizedContextId.length > 0 ? normalizedContextId : undefined;
        contextBound = Boolean(boundContextId);
        runStartedEmitted = false;
        runFinishedFromEvents = false;

        if (contextBound && boundContextId) {
          const resolved = this.resolveThreadIdOnce(boundContextId);
          boundContextId = resolved;
          contextBound = Boolean(resolved);
          this.hasBoundContextId = contextBound;
        }

          const bindContextId = (contextId?: string) => {
            const normalized = contextId?.trim();
            if (!normalized || contextBound) {
              if (contextBound && !runStartedEmitted) {
                emitRunStarted();
                flushPendingEvents();
              }
              return;
            }

            const resolved = this.resolveThreadIdOnce(normalized);
            boundContextId = resolved || normalized;
            contextBound = true;
            convertOptions.contextId = boundContextId;
            convertOptions.threadId = boundContextId;
            this.hasBoundContextId = true;

            emitRunStarted();
            flushPendingEvents();
          };

          const convertOptions: ConvertA2AEventOptions = {
            role: "assistant",
            messageIdMap: this.messageIdMap,
            onTextDelta: ({ messageId, delta }: { messageId: string; delta: string }) => {
              aggregatedText.set(messageId, (aggregatedText.get(messageId) ?? "") + delta);
            },
            getCurrentText: (messageId: string) => aggregatedText.get(messageId),
            source: "a2a",
            surfaceTracker,
            sharedStateTracker,
            artifactBasePath: runOptions.artifactBasePath,
            threadId: resolveThreadIdForRun(),
            runId: input.runId,
            taskId: runOptions.taskId ?? converted.taskId,
            contextId: normalizeId(boundContextId) ?? normalizeId(this.threadId) ?? undefined,
            onContextId: bindContextId,
          };

          emitRunStarted = () => {
            if (runStartedEmitted) {
              return;
            }
            const threadIdForRun = resolveThreadIdForRun();
            const runStarted: RunStartedEvent = {
              type: EventType.RUN_STARTED,
              threadId: threadIdForRun,
              runId: input.runId,
            };
            subscriber.next(runStarted);
            runStartedEmitted = true;
          };

          const recordRunFinished = (events: BaseEvent[]) => {
            if (events.some((event) => event.type === EventType.RUN_FINISHED)) {
              runFinishedFromEvents = true;
            }
          };

          flushPendingEvents = () => {
            if (pendingEvents.length === 0) {
              return;
            }
            emitRunStarted();
            for (const event of pendingEvents) {
              subscriber.next(event);
            }
            recordRunFinished(pendingEvents);
            pendingEvents.length = 0;
          };

          const dispatchEvents = (events: BaseEvent[]): boolean => {
            if (events.length === 0) {
              return false;
            }

            const sawRunFinished = events.some((event) => event.type === EventType.RUN_FINISHED);

            if (!runStartedEmitted && !contextBound) {
              pendingEvents.push(...events);
              if (sawRunFinished) {
                runFinishedFromEvents = true;
              }
              return sawRunFinished;
            }

            emitRunStarted();

            for (const event of events) {
              subscriber.next(event);
            }

            if (sawRunFinished) {
              runFinishedFromEvents = true;
            }

            return sawRunFinished;
          };

          const processRawEvent = (event: A2AStreamEvent): boolean => {
            rawEvents.push(event);
            bindContextId(this.extractContextId(event));
            const events = convertA2AEventToAGUIEvents(event, convertOptions);
            return dispatchEvents(events);
          };
          if (!targetMessage && !runOptions.subscribeOnly) {
            emitRunStarted();
            const runFinished: RunFinishedEvent = {
              type: EventType.RUN_FINISHED,
              threadId: boundContextId ?? this.threadId ?? input.threadId ?? input.runId,
              runId: input.runId,
            } as unknown as RunFinishedEvent;
            dispatchEvents([runFinished]);
            subscriber.complete();
            return;
          }

          if (contextBound) {
            emitRunStarted();
          }

          const targetMessagePayload = targetMessage;

          const sendParams = targetMessagePayload
            ? await this.createSendParams(converted, typedInput, runOptions)
            : undefined;

          let summary: A2AAgentRunResultSummary | undefined;

          try {
            if (runOptions.mode === "send") {
              if (!sendParams) {
                throw new Error("A2A send mode requires a message payload.");
              }
              summary = await this.blockingMessage(
                sendParams as MessageSendParams,
                convertOptions,
                processRawEvent,
                rawEvents,
              );
            } else if (runOptions.taskId && runOptions.subscribeOnly) {
              summary = await this.resubscribeToTask(
                runOptions.taskId,
                convertOptions,
                processRawEvent,
                rawEvents,
                runOptions.historyLength,
              );
            } else {
              if (!sendParams) {
                throw new Error("A2A stream mode requires a message payload.");
              }
              summary = await this.streamMessage(
                sendParams as MessageSendParams,
                convertOptions,
                processRawEvent,
                rawEvents,
              );
            }
            } catch (error) {
              if (runOptions.mode === "stream" && !runOptions.subscribeOnly) {
                summary = await this.fallbackToBlocking(
                  sendParams as MessageSendParams,
                  convertOptions,
                  processRawEvent,
                  rawEvents,
                );
              } else {
                throw error;
              }
            }

          flushPendingEvents();

          if (!runFinishedFromEvents && !summary?.finishedEarly) {
            const runFinished: RunFinishedEvent = {
              type: EventType.RUN_FINISHED,
              threadId: boundContextId ?? this.threadId ?? input.threadId ?? input.runId,
              runId: input.runId,
            };
            dispatchEvents([runFinished]);
          }

            subscriber.complete();
          },
        );
      } catch (error) {
          emitRunStarted();
          flushPendingEvents();
          const runError: RunErrorEvent = {
            type: EventType.RUN_ERROR,
            message: (error as Error).message ?? "Unknown A2A error",
          };
          subscriber.next(runError);
          subscriber.error(error);
        }
      };

      run();

      return () => {};
    });
  }

  private resolveContextId(requested?: string): string | undefined {
    const trimmed = requested?.trim();
    if (trimmed) {
      return trimmed;
    }

    if (this.hasBoundContextId && this.threadId) {
      return this.threadId;
    }

    return undefined;
  }

  private projectEngramRecords(
    records: EngramRecord[],
    convertOptions: ConvertA2AEventOptions,
  ): BaseEvent[] {
    if (records.length === 0) {
      return [];
    }

    const artifactUpdate = {
      kind: "artifact-update",
      contextId: convertOptions.contextId,
      taskId: convertOptions.taskId,
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: "engram-snapshot",
        parts: records.map((record, index) => ({
          kind: "data" as const,
          data: {
            type: "engram/event",
            event: {
              kind: "snapshot" as const,
              key: record.key,
              record,
              version: record.version,
              sequence: record.version ? String(record.version) : String(index + 1),
              updatedAt: record.updatedAt,
            },
          },
        })),
      },
    } as unknown as A2AStreamEvent;

    return convertA2AEventToAGUIEvents(artifactUpdate, convertOptions);
  }

  private async applyEngramSyncState(
    state: unknown,
    filter?: EngramSubscribeParams["filter"],
    contextId?: string,
  ): Promise<void> {
    const view = (state as { view?: { engram?: Record<string, unknown> } })?.view ?? {};
    const engramState = (view as { engram?: Record<string, unknown> }).engram ?? {};

    const matchesFilter = (key: string): boolean => {
      if (!filter) {
        return true;
      }

      const prefix = filter.keyPrefix;
      if (prefix && !key.startsWith(prefix)) {
        return false;
      }

      if (filter.key && filter.key.key && filter.key.key !== key) {
        return false;
      }

      return true;
    };

    for (const [key, rawValue] of Object.entries(engramState)) {
      if (!matchesFilter(key)) {
        continue;
      }

      if (rawValue === null) {
        await this.engramDelete({ key: { key }, contextId });
        continue;
      }

      const record = (rawValue ?? {}) as Partial<EngramRecord> & { value?: unknown };
      const params: EngramSetParams = {
        key: { key },
        value: record.value ?? rawValue,
        ...(typeof record.version === "number" ? { expectedVersion: record.version } : {}),
        ...(Array.isArray(record.tags) ? { tags: record.tags } : {}),
        ...(record.labels && typeof record.labels === "object" ? { labels: record.labels } : {}),
        ...(contextId ? { contextId } : {}),
      };

      await this.engramSet(params);
    }
  }

  private emitEmptySnapshotIfNeeded(
    tracker: ReturnType<typeof createSharedStateTracker>,
    subscriber: { next: (event: BaseEvent) => void },
    runId?: string,
    threadId?: string,
  ) {
    if (tracker.emittedSnapshot) {
      return;
    }

    const snapshot: StateSnapshotEvent = {
      type: EventType.STATE_SNAPSHOT,
      snapshot: tracker.state,
      ...(threadId ? { threadId } : {}),
      ...(runId ? { runId } : {}),
    };
    tracker.emittedSnapshot = true;
    subscriber.next(snapshot);
  }

  private async handleEngramRun(
    forwardedEngram: NonNullable<EngramForwardedProps["engram"]>,
    input: A2ARunInput,
    subscriber: { next: (event: BaseEvent) => void; complete: () => void },
    fallbackThreadId: string,
  ): Promise<void> {
    const mode = forwardedEngram.mode as EngramRunMode | undefined;
    if (!mode) {
      throw new Error("Engram run requested without a mode. Provide forwardedProps.engram.mode.");
    }

    if (!this.defaultEngramEnabled) {
      throw new Error("Engram is disabled for this agent. Enable Engram at construction to use Engram modes.");
    }

    if ((input.messages?.length ?? 0) > 0) {
      throw new Error("Engram runs do not accept messages. Use an empty message array with engram.mode.");
    }

    const contextId = this.resolveContextId(input.threadId ?? this.threadId) ?? fallbackThreadId;
    const tracker = createSharedStateTracker(input.state as Record<string, unknown> | undefined);
    const convertOptions: ConvertA2AEventOptions = {
      role: "assistant",
      messageIdMap: new Map<string, string>(),
      sharedStateTracker: tracker,
      artifactBasePath: DEFAULT_ARTIFACT_BASE_PATH,
      contextId,
      taskId: input.forwardedProps?.a2a?.taskId,
      threadId: contextId,
      runId: input.runId,
      source: "a2a",
    };

    const runStarted: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: contextId,
      runId: input.runId,
    };
    subscriber.next(runStarted);

    const finish = () => {
      const runFinished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: contextId,
        runId: input.runId,
      };
      subscriber.next(runFinished);
      subscriber.complete();
    };

    if (mode === "hydrate_stream") {
      const filter = forwardedEngram.filter ?? { keyPrefix: "" };
      let emitted = false;
      for await (const event of this.streamEngram({
        filter,
        includeSnapshot: true,
        initialState: tracker.state,
        sharedStateTracker: tracker,
        contextId,
        engram: true,
      })) {
        emitted = true;
        subscriber.next(event);
      }

      if (!emitted) {
        this.emitEmptySnapshotIfNeeded(tracker, subscriber, input.runId, contextId);
      }

      finish();
      return;
    }

    if (mode === "hydrate_once") {
      const listResult = await this.engramList(
        { filter: forwardedEngram.filter, contextId },
        { extensionUri: this.defaultEngramExtensionUri, engram: true },
      );

      if (!listResult.records?.length) {
        this.emitEmptySnapshotIfNeeded(tracker, subscriber, input.runId, contextId);
      } else {
        const events = this.projectEngramRecords(listResult.records, convertOptions);
        for (const event of events) {
          subscriber.next(event);
        }
      }

      finish();
      return;
    }

    if (mode === "sync") {
      await this.applyEngramSyncState(input.state, forwardedEngram.filter, contextId);

      const listResult = await this.engramList(
        { filter: forwardedEngram.filter, contextId },
        { extensionUri: this.defaultEngramExtensionUri, engram: true },
      );

      if (!listResult.records?.length) {
        this.emitEmptySnapshotIfNeeded(tracker, subscriber, input.runId, contextId);
      } else {
        const events = this.projectEngramRecords(listResult.records, convertOptions);
        for (const event of events) {
          subscriber.next(event);
        }
      }

      finish();
      return;
    }

    throw new Error(`Unknown Engram mode: ${mode}`);
  }

  private async ensureEngramSupportIfEnabled(options: ResolvedA2ARunOptions): Promise<void> {
    if (!options.engramEnabled) {
      return;
    }

    await this.ensureEngramSupport(options.engramExtensionUri);
  }

  private async ensureEngramSupport(extensionUri: string): Promise<void> {
    if (this.engramSupportChecked && extensionUri === this.defaultEngramExtensionUri) {
      return;
    }

    const card = await this.a2aClient.getAgentCard();
    const extensions = (card as { capabilities?: { extensions?: unknown } }).capabilities?.extensions ?? [];
    const supported = Array.isArray(extensions)
      ? extensions.some((extension) =>
          typeof extension === "string"
            ? extension === extensionUri
            : typeof extension === "object" && extension !== null && (extension as { uri?: string }).uri === extensionUri,
        )
      : false;

    if (!supported) {
      throw new Error(`Engram extension ${extensionUri} not advertised by agent card.`);
    }

    if (extensionUri === this.defaultEngramExtensionUri) {
      this.engramSupportChecked = true;
    }
  }

  private async withEngramContext<T>(
    enabled: boolean,
    extensionUri: string,
    operation: () => Promise<T>,
    options: { forceHeader?: boolean } = {},
  ): Promise<T> {
    const previousEnabled = this.engramRuntimeEnabled;
    const previousUri = this.engramRuntimeExtensionUri;
    const previousForce = this.forceEngramHeader;

    this.engramRuntimeEnabled = enabled;
    this.engramRuntimeExtensionUri = extensionUri;
    this.forceEngramHeader = options.forceHeader ?? false;

    try {
      return await operation();
    } finally {
      this.engramRuntimeEnabled = previousEnabled;
      this.engramRuntimeExtensionUri = previousUri;
      this.forceEngramHeader = previousForce;
    }
  }

  private shouldIncludeEngramHeader(init?: RequestInit, force?: boolean): boolean {
    const forceHeader = force ?? this.forceEngramHeader;
    if (!this.engramRuntimeEnabled && !forceHeader) {
      return false;
    }

    if (forceHeader) {
      return true;
    }

    if (!init?.body || typeof init.body !== "string") {
      return false;
    }

    try {
      const parsed = JSON.parse(init.body as string) as {
        method?: string;
        params?: { metadata?: { engram?: unknown }; message?: { extensions?: string[] } };
      };

      if (typeof parsed.method === "string" && parsed.method.startsWith("engram/")) {
        return true;
      }

      const params = parsed.params ?? {};
      if (params.metadata && "engram" in params.metadata) {
        return true;
      }

      const extensions = params.message?.extensions ?? [];
      return Array.isArray(extensions) && extensions.includes(this.engramRuntimeExtensionUri);
    } catch {
      return false;
    }
  }

  private addEngramHeader(headers: Headers, init?: RequestInit, force?: boolean) {
    if (!this.shouldIncludeEngramHeader(init, force)) {
      return;
    }

    const existing = headers.get("X-A2A-Extensions");
    const values = new Set<string>();
    if (existing) {
      for (const value of existing.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        values.add(value);
      }
    }
    values.add(this.engramRuntimeExtensionUri);
    headers.set("X-A2A-Extensions", Array.from(values).join(","));
  }

  private patchFetch(force?: boolean) {
    const originalFetch = globalThis.fetch;
    if (!originalFetch) {
      return () => {};
    }

    const extensionFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      this.addEngramHeader(headers, init, force);
      const nextInit: RequestInit = {
        ...init,
        headers,
      };
      return originalFetch(input, nextInit);
    };

    globalThis.fetch = extensionFetch;

    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  private resolveRunOptions(input: A2ARunInput): ResolvedA2ARunOptions {
    const forwardedOptions = (input.forwardedProps?.a2a ?? {}) as A2ARunOptions;
    const merged: A2ARunOptions = { ...this.defaultRunOptions, ...forwardedOptions };

    const mode = merged.mode ?? "stream";
    const acceptedOutputModes = merged.acceptedOutputModes ?? ["text"];
    const includeToolMessages = merged.includeToolMessages ?? true;
    const includeSystemMessages = merged.includeSystemMessages ?? false;
    const includeDeveloperMessages = merged.includeDeveloperMessages ?? false;
    const artifactBasePath = merged.artifactBasePath ?? DEFAULT_ARTIFACT_BASE_PATH;
    const subscribeOnly = mode === "send" ? false : merged.subscribeOnly ?? false;
    const contextId = this.resolveContextId(merged.contextId);
    const engramEnabled = this.defaultEngramEnabled;
    const engramExtensionUri = this.defaultEngramExtensionUri;

    return {
      ...merged,
      mode,
      acceptedOutputModes,
      includeToolMessages,
      includeSystemMessages,
      includeDeveloperMessages,
      artifactBasePath,
      subscribeOnly,
      contextId,
      engramEnabled,
      engramExtensionUri,
    };
  }

  private extractContextId(event: A2AStreamEvent): string | undefined {
    if (event && typeof event === "object" && "contextId" in event) {
      const contextId = (event as { contextId?: unknown }).contextId;
      if (typeof contextId === "string" && contextId.trim().length > 0) {
        return contextId;
      }
    }

    return undefined;
  }

  private prepareConversation(
    input: A2ARunInput,
    options: ResolvedA2ARunOptions,
  ): ConvertedA2AMessages {
    return convertAGUIMessagesToA2A(input.messages ?? [], {
      contextId: options.contextId,
      taskId: options.taskId,
      includeToolMessages: options.includeToolMessages,
      includeSystemMessages: options.includeSystemMessages,
      includeDeveloperMessages: options.includeDeveloperMessages,
      engramUpdate: options.engramUpdate,
      engramEnabled: options.engramEnabled,
      context: input.context,
      engramExtensionUri: options.engramExtensionUri,
      resume: options.resume,
    });
  }

  private async createSendParams(
    converted: ConvertedA2AMessages,
    input: A2ARunInput,
    options: ResolvedA2ARunOptions,
  ): Promise<MessageSendParams> {
    const fallbackMessage = converted.history[converted.history.length - 1];
    const baseMessage = converted.targetMessage ?? converted.latestUserMessage ?? fallbackMessage;

    if (!baseMessage) {
      throw new Error("No A2A message payload to send.");
    }

    const resolvedContextId = baseMessage.contextId ?? converted.contextId ?? options.contextId;
    const resolvedTaskId = baseMessage.taskId ?? options.taskId;

    const message: A2AMessage = {
      ...baseMessage,
      messageId: baseMessage.messageId ?? randomUUID(),
      ...(resolvedContextId ? { contextId: resolvedContextId } : {}),
      ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
    };

    const messageMetadata: Record<string, unknown> = { ...(message.metadata ?? {}) };

    if (converted.metadata?.context) {
      messageMetadata.context = converted.metadata.context;
    }

    if (converted.metadata?.engram) {
      messageMetadata.engram = converted.metadata.engram;
    }

    if (converted.metadata?.resume) {
      messageMetadata.resume = converted.metadata.resume;
    }

    if (Object.keys(messageMetadata).length) {
      message.metadata = messageMetadata;
    }

    const configuration: MessageSendConfiguration = {
      acceptedOutputModes: options.acceptedOutputModes,
      ...(options.historyLength ? { historyLength: options.historyLength } : {}),
    };

    const metadata: Record<string, unknown> = {};

    if (converted.metadata) {
      Object.assign(metadata, converted.metadata);
    }

    metadata.mode = options.mode;
    if (options.taskId) {
      metadata.taskId = options.taskId;
    }

    if (options.contextId) {
      metadata.contextId = options.contextId;
    }

    return {
      message,
      configuration,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }

  private async emitTaskSnapshot(
    taskParams: { id: string; historyLength?: number; contextId?: string },
    processEvent: (event: A2AStreamEvent) => boolean,
  ): Promise<{ finishedEarly: boolean }> {
    const taskResponse = await this.a2aClient.getTask(taskParams as { id: string; historyLength?: number });

    if (this.a2aClient.isErrorResponse(taskResponse)) {
      const message = taskResponse.error?.message ?? "Failed to fetch A2A task snapshot";
      throw new Error(message);
    }

    let finishedEarly = false;

    if (taskResponse.result) {
      finishedEarly = processEvent(taskResponse.result as unknown as A2AStreamEvent);
    }

    return { finishedEarly };
  }

  private async streamMessage(
    params: MessageSendParams,
    convertOptions: ConvertA2AEventOptions,
    processEvent: (event: A2AStreamEvent) => boolean,
    rawEvents: A2AStreamEvent[],
  ): Promise<A2AAgentRunResultSummary> {
    let finishedEarly = false;

    const taskIdForSnapshot = params.message?.taskId ?? convertOptions.taskId;
    if (taskIdForSnapshot) {
      const { finishedEarly: snapshotFinished } = await this.emitTaskSnapshot(
        {
          id: taskIdForSnapshot,
          ...(params.configuration?.historyLength ? { historyLength: params.configuration.historyLength } : {}),
          ...(convertOptions.contextId ? { contextId: convertOptions.contextId } : {}),
        },
        processEvent,
      );

      finishedEarly = snapshotFinished;
    }

    if (finishedEarly) {
      return {
        messages: [],
        rawEvents,
        finishedEarly,
      };
    }

    const stream = this.a2aClient.sendMessageStream(params);
    if (!isAsyncIterable(stream)) {
      throw new Error("A2A streaming unsupported");
    }
    for await (const chunk of stream) {
      finishedEarly = processEvent(chunk as A2AStreamEvent) || finishedEarly;

      if (finishedEarly) {
        break;
      }
    }

    return {
      messages: [],
      rawEvents,
      finishedEarly,
    };
  }

  private async fallbackToBlocking(
    params: MessageSendParams,
    convertOptions: ConvertA2AEventOptions,
    processEvent: (event: A2AStreamEvent) => boolean,
    rawEvents: A2AStreamEvent[],
  ): Promise<A2AAgentRunResultSummary> {
    const configuration: MessageSendConfiguration = {
      ...params.configuration,
      acceptedOutputModes: params.configuration?.acceptedOutputModes ?? [
        "text",
      ],
      blocking: true,
    };

    return this.blockingMessage(
      {
        ...params,
        configuration,
      },
      convertOptions,
      processEvent,
      rawEvents,
    );
  }

  private async blockingMessage(
    params: MessageSendParams,
    _convertOptions: ConvertA2AEventOptions,
    processEvent: (event: A2AStreamEvent) => boolean,
    rawEvents: A2AStreamEvent[],
  ): Promise<A2AAgentRunResultSummary> {
    const response = await this.a2aClient.sendMessage(params);

    if (this.a2aClient.isErrorResponse(response)) {
      const errorMessage =
        response.error?.message ?? "Unknown error from A2A agent";
      console.error("A2A sendMessage error", response.error);
      throw new Error(errorMessage);
    }

    const result = response.result as A2AStreamEvent;
    const finishedEarly = processEvent(result);

    return {
      messages: [],
      rawEvents,
      finishedEarly,
    };
  }

  private async resubscribeToTask(
    taskId: string,
    convertOptions: ConvertA2AEventOptions,
    processEvent: (event: A2AStreamEvent) => boolean,
    rawEvents: A2AStreamEvent[],
    historyLength?: number,
  ): Promise<A2AAgentRunResultSummary> {
    let finishedEarly = false;
    let taskParams = {
      id: taskId,
      taskId,
      ...(historyLength ? { historyLength } : {}),
      ...(convertOptions.contextId ? { contextId: convertOptions.contextId } : {}),
    };
    const { finishedEarly: snapshotFinished } = await this.emitTaskSnapshot(
      taskParams,
      processEvent,
    );

    if (snapshotFinished) {
      return {
        messages: [],
        rawEvents,
        finishedEarly: true,
      };
    }

    if (convertOptions.contextId) {
      taskParams = { ...taskParams, contextId: convertOptions.contextId };
    }

    const stream = this.a2aClient.resubscribeTask(taskParams as { id: string });
    for await (const chunk of stream) {
      finishedEarly = processEvent(chunk as A2AStreamEvent) || finishedEarly;

      if (finishedEarly) {
        break;
      }
    }

    return {
      messages: [],
      rawEvents,
      finishedEarly,
    };
  }

  private extractEngramEvents(event: A2AStreamEvent): EngramEvent[] {
    if ((event as { kind?: string }).kind !== "artifact-update") {
      return [];
    }

    const artifactEvent = event as unknown as {
      artifact?: { parts?: Array<{ kind?: string; data?: unknown }> };
    };

    const parts = artifactEvent.artifact?.parts ?? [];
    const engramEvents: EngramEvent[] = [];

    for (const part of parts) {
      if (part && (part as { kind?: string }).kind === "data") {
        const payload = (part as { data?: unknown }).data;
        if (payload && typeof payload === "object") {
          const candidate = payload as { type?: unknown; event?: unknown };
          if (candidate.type === "engram/event" && candidate.event && typeof candidate.event === "object") {
            engramEvents.push(candidate.event as EngramEvent);
          }
        }
      }
    }

    return engramEvents;
  }

  private async engramRpc<T>(
    method: string,
    params: unknown,
    _options?: EngramRequestOptions,
  ): Promise<T> {
    const extensionUri = this.defaultEngramExtensionUri;
    const enabled = this.defaultEngramEnabled;
    void _options;

    if (!enabled) {
      throw new Error("Engram is disabled for this agent. Enable Engram to call Engram RPC methods.");
    }

    await this.ensureEngramSupport(extensionUri);

    const clientWithRpc = this.a2aClient as unknown as {
      _postRpcRequest: (method: string, params: unknown) => Promise<unknown>;
    };

    return this.withEngramContext(enabled, extensionUri, async () => {
      const restore = this.patchFetch();
      try {
        const response = await clientWithRpc._postRpcRequest(method, params);

        if (this.a2aClient.isErrorResponse(response as JSONRPCResponse)) {
          const message = (response as { error?: { message?: string } }).error?.message ?? `Engram RPC ${method} failed`;
          throw new Error(message);
        }

        return (response as { result?: T }).result as T;
      } finally {
        restore();
      }
    });
  }

  public async engramGet(params: EngramGetParams, options?: EngramRequestOptions): Promise<EngramGetResult> {
    return this.engramRpc<EngramGetResult>("engram/get", params, options);
  }

  public async engramList(params: EngramListParams, options?: EngramRequestOptions): Promise<EngramListResult> {
    return this.engramRpc<EngramListResult>("engram/list", params, options);
  }

  public async engramSet(params: EngramSetParams, options?: EngramRequestOptions): Promise<EngramSetResult> {
    return this.engramRpc<EngramSetResult>("engram/set", params, options);
  }

  public async engramPatch(
    params: EngramPatchParams,
    options?: EngramRequestOptions,
  ): Promise<EngramPatchResult> {
    return this.engramRpc<EngramPatchResult>("engram/patch", params, options);
  }

  public async engramDelete(
    params: EngramDeleteParams,
    options?: EngramRequestOptions,
  ): Promise<EngramDeleteResult> {
    return this.engramRpc<EngramDeleteResult>("engram/delete", params, options);
  }

  public async engramSubscribe(
    params: EngramSubscribeParams,
    options?: EngramRequestOptions,
  ): Promise<EngramSubscribeResult> {
    return this.engramRpc<EngramSubscribeResult>("engram/subscribe", params, options);
  }

  public async *streamEngram(options: EngramSubscriptionOptions): AsyncGenerator<BaseEvent> {
    const engramEnabled = this.defaultEngramEnabled;
    const extensionUri = this.defaultEngramExtensionUri;

    if (!engramEnabled) {
      throw new Error("Engram is disabled for this agent. Enable Engram to stream Engram events.");
    }

    await this.ensureEngramSupport(extensionUri);

    const messageIdMap = new Map<string, string>();
    const tracker = options.sharedStateTracker ?? createSharedStateTracker(options.initialState);
    const convertOptions: ConvertA2AEventOptions = {
      role: "assistant",
      messageIdMap,
      sharedStateTracker: tracker,
      artifactBasePath: options.artifactBasePath ?? DEFAULT_ARTIFACT_BASE_PATH,
      contextId: options.contextId,
      source: "a2a",
    };

    let taskId = options.taskId;
    let lastSequence = options.fromSequence;
    let includeSnapshot = options.includeSnapshot ?? true;

    const previousEnabled = this.engramRuntimeEnabled;
    const previousUri = this.engramRuntimeExtensionUri;
    const previousForce = this.forceEngramHeader;

    this.engramRuntimeEnabled = engramEnabled;
    this.engramRuntimeExtensionUri = extensionUri;
    this.forceEngramHeader = true;

    const subscribe = async () => {
      if (!options.filter) {
        throw new Error("Engram filter is required to start a subscription when taskId is not provided.");
      }

      const result = await this.engramSubscribe(
        {
          filter: options.filter,
          includeSnapshot,
          fromSequence: lastSequence,
          contextId: options.contextId,
        },
        { engram: engramEnabled, extensionUri },
      );

      taskId = result.taskId;
      convertOptions.taskId = result.taskId;
      includeSnapshot = false;
    };

    if (!taskId) {
      await subscribe();
    } else {
      convertOptions.taskId = taskId;
    }

    try {
      while (taskId) {
        try {
          const stream = this.a2aClient.resubscribeTask(
            { id: taskId!, ...(options.contextId ? { contextId: options.contextId } : {}) } as { id: string },
          );

          for await (const chunk of stream) {
            const engEvents = this.extractEngramEvents(chunk as A2AStreamEvent);
            if (engEvents.length) {
              lastSequence = engEvents[engEvents.length - 1]?.sequence ?? lastSequence;
            }

            const events = convertA2AEventToAGUIEvents(chunk as A2AStreamEvent, convertOptions);
            for (const event of events) {
              yield event;
            }
          }
          break;
        } catch (error) {
          if (!options.filter) {
            throw error;
          }

          await subscribe();
        }
      }
    } finally {
      this.engramRuntimeEnabled = previousEnabled;
      this.engramRuntimeExtensionUri = previousUri;
      this.forceEngramHeader = previousForce;
    }
  }

  private initializeExtension(client: A2AClient) {
    const wrapPromise = async <T>(operation: () => Promise<T>): Promise<T> => {
      const restore = this.patchFetch();
      try {
        return await operation();
      } finally {
        restore();
      }
    };

    const wrapStream = <TArgs extends unknown[], T>(
      original: ((...args: TArgs) => AsyncGenerator<T, void, undefined>) | undefined,
    ) => {
      if (!original) {
        return undefined;
      }

      return (...args: TArgs) => {
        const restore = this.patchFetch();
        let iterator: AsyncIterable<T> | Promise<unknown>;
        try {
          iterator = original(...args) as AsyncIterable<T> | Promise<unknown>;
        } catch (error) {
          restore();
          throw error;
        }

        const wrappedIterator = (async function* () {
          try {
            if (!isAsyncIterable(iterator)) {
              await Promise.resolve(iterator);
              throw new Error("A2A streaming unsupported");
            }

            for await (const value of iterator as AsyncIterable<T>) {
              yield value;
            }
          } finally {
            restore();
          }
        })();

        return wrappedIterator;
      };
    };

    const originalSendMessage = client.sendMessage.bind(client);
    client.sendMessage = (params) =>
      wrapPromise(() => originalSendMessage(params));

    const originalSendMessageStream = client.sendMessageStream?.bind(client);
    const wrappedSendMessageStream = wrapStream(originalSendMessageStream);
    if (wrappedSendMessageStream) {
      client.sendMessageStream =
        wrappedSendMessageStream as typeof client.sendMessageStream;
    }

    const originalResubscribeTask = client.resubscribeTask?.bind(client);
    const wrappedResubscribeTask = wrapStream(originalResubscribeTask);
    if (wrappedResubscribeTask) {
      client.resubscribeTask =
        wrappedResubscribeTask as typeof client.resubscribeTask;
    }
  }

  private createSurfaceTracker(): SurfaceTracker {
    const seenSurfaceIds = new Set<string>();
    return {
      has: (surfaceId: string) => seenSurfaceIds.has(surfaceId),
      add: (surfaceId: string) => {
        seenSurfaceIds.add(surfaceId);
      },
    };
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function";
}
