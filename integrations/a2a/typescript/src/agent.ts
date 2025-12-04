import { AbstractAgent, EventType, randomUUID } from "@ag-ui/client";
import type {
  AgentConfig,
  BaseEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import type { A2AClient } from "@a2a-js/sdk/client";
import type {
  MessageSendConfiguration,
  MessageSendParams,
  Message as A2AMessage,
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
} from "./types";

export interface A2AAgentConfig extends AgentConfig {
  a2aClient: A2AClient;
  runOptions?: Partial<A2ARunOptions>;
}

type A2ARunInput = Omit<RunAgentInput, "forwardedProps"> & {
  forwardedProps?: { a2a?: A2ARunOptions } & Record<string, unknown>;
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
  A2ARunOptions & { contextId?: string };

export class A2AAgent extends AbstractAgent {
  private readonly a2aClient: A2AClient;
  private readonly messageIdMap = new Map<string, string>();
  private readonly defaultRunOptions: Partial<A2ARunOptions>;
  private hasBoundContextId = false;

  constructor(config: A2AAgentConfig) {
    const { a2aClient, runOptions, ...rest } = config;
    if (!a2aClient) {
      throw new Error("A2AAgent requires a configured A2AClient instance.");
    }

    super({ ...rest, deferThreadId: true });

    this.a2aClient = a2aClient;
    this.defaultRunOptions = runOptions ?? {};
    this.initializeExtension(this.a2aClient);
  }

  clone() {
    return new A2AAgent({
      a2aClient: this.a2aClient,
      debug: this.debug,
      runOptions: this.defaultRunOptions,
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
          let runOptions = this.resolveRunOptions(typedInput);
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
      context: input.context,
      engramExtensionUri: ENGRAM_EXTENSION_URI,
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

  private initializeExtension(client: A2AClient) {
    const shouldIncludeEngram = (init?: RequestInit): boolean => {
      if (!init?.body || typeof init.body !== "string") {
        return false;
      }

      try {
        const parsed = JSON.parse(init.body as string) as {
          params?: { metadata?: { engram?: unknown }; message?: { extensions?: string[] } };
        };
        const params = parsed.params ?? {};
        if (params.metadata && "engram" in params.metadata) {
          return true;
        }
        const extensions = params.message?.extensions ?? [];
        return Array.isArray(extensions) && extensions.includes(ENGRAM_EXTENSION_URI);
      } catch {
        return false;
      }
    };

    const addExtensionHeader = (headers: Headers, init?: RequestInit) => {
      if (!shouldIncludeEngram(init)) {
        return;
      }

      const existing = headers.get("X-A2A-Extensions");
      const values = new Set<string>();
      if (existing) {
        for (const value of existing.split(",").map((entry) => entry.trim()).filter(Boolean)) {
          values.add(value);
        }
      }
      values.add(ENGRAM_EXTENSION_URI);
      headers.set("X-A2A-Extensions", Array.from(values).join(","));
    };

    const patchFetch = () => {
      const originalFetch = globalThis.fetch;
      if (!originalFetch) {
        return () => {};
      }

      const extensionFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        addExtensionHeader(headers, init);
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
    };

    const wrapPromise = async <T>(operation: () => Promise<T>): Promise<T> => {
      const restore = patchFetch();
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

      return function wrapped(this: unknown, ...args: TArgs) {
        const restore = patchFetch();
        let iterator: AsyncIterable<T> | Promise<unknown>;
        try {
          iterator = original.apply(this, args) as AsyncIterable<T> | Promise<unknown>;
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
