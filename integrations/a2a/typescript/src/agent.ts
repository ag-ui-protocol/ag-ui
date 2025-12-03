import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { A2AClient } from "@a2a-js/sdk/client";
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
import { randomUUID } from "@ag-ui/client";

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
  A2ARunOptions & { contextId: string };

export class A2AAgent extends AbstractAgent {
  private readonly a2aClient: A2AClient;
  private readonly messageIdMap = new Map<string, string>();
  private readonly defaultRunOptions: Partial<A2ARunOptions>;
  private readonly contextIds = new Map<string, string>();

  constructor(config: A2AAgentConfig) {
    const { a2aClient, runOptions, ...rest } = config;
    if (!a2aClient) {
      throw new Error("A2AAgent requires a configured A2AClient instance.");
    }

    super(rest);

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
        const runStarted: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };
        subscriber.next(runStarted);

        try {
          const runOptions = this.resolveRunOptions(typedInput);
          const converted = this.prepareConversation(typedInput, runOptions);
          const targetMessage =
            converted.targetMessage ??
            converted.latestUserMessage ??
            converted.history[converted.history.length - 1];

          if (!targetMessage && !runOptions.subscribeOnly) {
            const runFinished: RunFinishedEvent = {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            } as unknown as RunFinishedEvent;
            subscriber.next(runFinished);
            subscriber.complete();
            return;
          }

          const sendParams = targetMessage
            ? await this.createSendParams(converted, typedInput, runOptions)
            : undefined;

          this.messageIdMap.clear();
          const aggregatedText = new Map<string, string>();
          const surfaceTracker = this.createSurfaceTracker();
          const sharedStateTracker = createSharedStateTracker();
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
            threadId: input.threadId,
            runId: input.runId,
            taskId: runOptions.taskId ?? converted.taskId,
            contextId: runOptions.contextId,
          };

          let summary: A2AAgentRunResultSummary | undefined;

          try {
            if (runOptions.mode === "send") {
              if (!sendParams) {
                throw new Error("A2A send mode requires a message payload.");
              }
              summary = await this.blockingMessage(
                sendParams as MessageSendParams,
                subscriber,
                convertOptions,
              );
            } else if (runOptions.taskId && runOptions.subscribeOnly) {
              summary = await this.resubscribeToTask(
                runOptions.taskId,
                subscriber,
                convertOptions,
                runOptions.historyLength,
              );
            } else {
              if (!sendParams) {
                throw new Error("A2A stream mode requires a message payload.");
              }
              summary = await this.streamMessage(
                sendParams as MessageSendParams,
                subscriber,
                convertOptions,
              );
            }
          } catch (error) {
            if (runOptions.mode === "stream" && !runOptions.subscribeOnly) {
              summary = await this.fallbackToBlocking(
                sendParams as MessageSendParams,
                subscriber,
                error as Error,
                convertOptions,
              );
            } else {
              throw error;
            }
          }

          if (!summary?.finishedEarly) {
            const runFinished: RunFinishedEvent = {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            };
            subscriber.next(runFinished);
          }
          subscriber.complete();
        } catch (error) {
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

  private resolveContextId(threadId: string, requested?: string, taskId?: string): string {
    if (requested) {
      return requested;
    }

    if (taskId) {
      return taskId;
    }

    const existing = this.contextIds.get(threadId);
    if (existing) {
      return existing;
    }

    const generated = randomUUID();
    this.contextIds.set(threadId, generated);
    return generated;
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
    const subscribeOnly =
      mode === "send"
        ? false
        : merged.subscribeOnly ?? Boolean(merged.taskId && mode === "stream");
    const contextId = this.resolveContextId(input.threadId, merged.contextId, merged.taskId);

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

    const message: A2AMessage = {
      ...baseMessage,
      messageId: baseMessage.messageId ?? randomUUID(),
      contextId: baseMessage.contextId ?? converted.contextId ?? options.contextId,
      taskId: baseMessage.taskId ?? options.taskId,
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

    metadata.contextId = options.contextId;

    return {
      message,
      configuration,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }

  private async streamMessage(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
    convertOptions: ConvertA2AEventOptions,
  ): Promise<A2AAgentRunResultSummary> {
    const rawEvents: A2AStreamEvent[] = [];
    let finishedEarly = false;

    const stream = this.a2aClient.sendMessageStream(params);
    for await (const chunk of stream) {
      rawEvents.push(chunk as A2AStreamEvent);
      const events = convertA2AEventToAGUIEvents(chunk as A2AStreamEvent, convertOptions);
      for (const event of events) {
        subscriber.next(event);
        if (event.type === EventType.RUN_FINISHED) {
          finishedEarly = true;
        }
      }

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
    subscriber: { next: (event: BaseEvent) => void },
    _error: Error,
    convertOptions: ConvertA2AEventOptions,
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
      subscriber,
      convertOptions,
    );
  }

  private async blockingMessage(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
    convertOptions: ConvertA2AEventOptions,
  ): Promise<A2AAgentRunResultSummary> {
    const response = await this.a2aClient.sendMessage(params);

    if (this.a2aClient.isErrorResponse(response)) {
      const errorMessage =
        response.error?.message ?? "Unknown error from A2A agent";
      console.error("A2A sendMessage error", response.error);
      throw new Error(errorMessage);
    }

    const rawEvents: A2AStreamEvent[] = [];

    const result = response.result as A2AStreamEvent;
    rawEvents.push(result);

    const events = convertA2AEventToAGUIEvents(result, convertOptions);

    let finishedEarly = false;
    for (const event of events) {
      subscriber.next(event);
      if (event.type === EventType.RUN_FINISHED) {
        finishedEarly = true;
      }
    }

    return {
      messages: [],
      rawEvents,
      finishedEarly,
    };
  }

  private async resubscribeToTask(
    taskId: string,
    subscriber: { next: (event: BaseEvent) => void },
    convertOptions: ConvertA2AEventOptions,
    historyLength?: number,
  ): Promise<A2AAgentRunResultSummary> {
    const rawEvents: A2AStreamEvent[] = [];
    let finishedEarly = false;
    const taskParams = {
      id: taskId,
      taskId,
      ...(historyLength ? { historyLength } : {}),
      ...(convertOptions.contextId ? { contextId: convertOptions.contextId } : {}),
    };
    const taskResponse = await this.a2aClient.getTask(taskParams as { id: string; historyLength?: number });

    if (this.a2aClient.isErrorResponse(taskResponse)) {
      const message = taskResponse.error?.message ?? "Failed to fetch A2A task snapshot";
      throw new Error(message);
    }

    if (taskResponse.result) {
      rawEvents.push(taskResponse.result as unknown as A2AStreamEvent);
      const snapshotEvents = convertA2AEventToAGUIEvents(
        taskResponse.result as unknown as A2AStreamEvent,
        convertOptions,
      );
      for (const event of snapshotEvents) {
        subscriber.next(event);
        if (event.type === EventType.RUN_FINISHED) {
          finishedEarly = true;
        }
      }

      if (finishedEarly) {
        return {
          messages: [],
          rawEvents,
          finishedEarly,
        };
      }
    }

    const stream = this.a2aClient.resubscribeTask(taskParams as { id: string });
    for await (const chunk of stream) {
      rawEvents.push(chunk as A2AStreamEvent);
      const events = convertA2AEventToAGUIEvents(chunk as A2AStreamEvent, convertOptions);
      for (const event of events) {
        subscriber.next(event);
        if (event.type === EventType.RUN_FINISHED) {
          finishedEarly = true;
        }
      }

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
        const iterator = original.apply(this, args);

        const wrappedIterator = (async function* () {
          try {
            for await (const value of iterator) {
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
