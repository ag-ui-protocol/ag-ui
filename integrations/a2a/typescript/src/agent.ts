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
import { convertAGUIMessagesToA2A, convertA2AEventToAGUIEvents } from "./utils";
import type {
  A2AAgentRunResultSummary,
  ConvertedA2AMessages,
  A2AStreamEvent,
} from "./types";
import { randomUUID } from "@ag-ui/client";

export interface A2AAgentConfig extends AgentConfig {
  agentUrl?: string;
  client?: A2AClient;
}

const A2A_UI_EXTENSION_URI = "https://a2ui.org/ext/a2a-ui/v0.1";

export class A2AAgent extends AbstractAgent {
  private readonly agentUrl?: string;
  private readonly a2aClient: A2AClient;
  private readonly messageIdMap = new Map<string, string>();

  constructor(config: A2AAgentConfig) {
    const { agentUrl, client, ...rest } = config;

    if (!agentUrl && !client) {
      throw new Error(
        "A2AAgent requires either an agentUrl or a preconfigured A2AClient.",
      );
    }

    super(rest);

    this.agentUrl = agentUrl;
    this.a2aClient = client ?? new A2AClient(agentUrl!);
    this.initializeA2UIExtension(this.a2aClient);
  }

  protected run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        const runStarted: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };
        subscriber.next(runStarted);

        if (!input.messages?.length) {
          const runFinished: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            result: {
              messages: [],
              rawEvents: [],
            },
          };
          subscriber.next(runFinished);
          subscriber.complete();
          return;
        }

        try {
          const converted = this.prepareConversation(input);

          if (!converted.latestUserMessage) {
            const runFinished: RunFinishedEvent = {
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
              result: {
                messages: [],
                rawEvents: [],
                info: "No user message to forward to A2A agent.",
              },
            } as unknown as RunFinishedEvent;
            subscriber.next(runFinished);
            subscriber.complete();
            return;
          }

          const sendParams = await this.createSendParams(converted, input);

          let summary: A2AAgentRunResultSummary | null = null;

          try {
            summary = await this.streamMessage(sendParams, subscriber);
          } catch (error) {
            summary = await this.fallbackToBlocking(
              sendParams,
              subscriber,
              error as Error,
            );
          }

          const runFinished: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            result: summary,
          };
          subscriber.next(runFinished);
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

  private prepareConversation(input: RunAgentInput): ConvertedA2AMessages {
    return convertAGUIMessagesToA2A(input.messages ?? [], {
      contextId: input.threadId,
    });
  }

  private async createSendParams(
    converted: ConvertedA2AMessages,
    input: RunAgentInput,
  ): Promise<MessageSendParams> {
    const latest = converted.latestUserMessage as A2AMessage;

    const message: A2AMessage = {
      ...latest,
      messageId: latest.messageId ?? randomUUID(),
      contextId: converted.contextId ?? input.threadId,
    };

    const configuration: MessageSendConfiguration = {
      acceptedOutputModes: ["text"],
    } as MessageSendConfiguration;

    return {
      message,
      configuration,
    } as MessageSendParams;
  }

  private async streamMessage(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
  ): Promise<A2AAgentRunResultSummary> {
    const aggregatedText = new Map<string, string>();
    const rawEvents: A2AStreamEvent[] = [];

    const stream = this.a2aClient.sendMessageStream(params);
    for await (const chunk of stream) {
      rawEvents.push(chunk as A2AStreamEvent);
      const events = convertA2AEventToAGUIEvents(chunk as A2AStreamEvent, {
        role: "assistant",
        messageIdMap: this.messageIdMap,
        onTextDelta: ({ messageId, delta }) => {
          aggregatedText.set(
            messageId,
            (aggregatedText.get(messageId) ?? "") + delta,
          );
        },
        getCurrentText: (messageId) => aggregatedText.get(messageId),
        source: this.agentUrl ?? "a2a",
      });
      for (const event of events) {
        subscriber.next(event);
      }
    }

    return {
      messages: Array.from(aggregatedText.entries()).map(
        ([messageId, text]) => ({ messageId, text }),
      ),
      rawEvents,
    };
  }

  private async fallbackToBlocking(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
    error: Error,
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
    );
  }

  private async blockingMessage(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
  ): Promise<A2AAgentRunResultSummary> {
    const response = await this.a2aClient.sendMessage(params);

    if (this.a2aClient.isErrorResponse(response)) {
      const errorMessage =
        response.error?.message ?? "Unknown error from A2A agent";
      console.error("A2A sendMessage error", response.error);
      throw new Error(errorMessage);
    }

    const aggregatedText = new Map<string, string>();
    const rawEvents: A2AStreamEvent[] = [];

    const result = response.result as A2AStreamEvent;
    rawEvents.push(result);

    const events = convertA2AEventToAGUIEvents(result, {
      role: "assistant",
      messageIdMap: this.messageIdMap,
      onTextDelta: ({ messageId, delta }) => {
        aggregatedText.set(
          messageId,
          (aggregatedText.get(messageId) ?? "") + delta,
        );
      },
      getCurrentText: (messageId) => aggregatedText.get(messageId),
      source: this.agentUrl ?? "a2a",
    });

    for (const event of events) {
      subscriber.next(event);
    }

    return {
      messages: Array.from(aggregatedText.entries()).map(
        ([messageId, text]) => ({ messageId, text }),
      ),
      rawEvents,
    };
  }

  static async getRemoteAgents(options: {
    agentUrls: string[];
    agentConfig?: AgentConfig;
  }): Promise<Record<string, A2AAgent>> {
    const { agentUrls, agentConfig } = options;

    const pairs = await Promise.all(
      agentUrls.map(async (url) => {
        const client = new A2AClient(url);

        const agent = new A2AAgent({
          ...(agentConfig ?? {}),
          agentUrl: url,
          client,
        });

        return [agent.agentId ?? url, agent] as const;
      }),
    );

    return Object.fromEntries(pairs);
  }

  private initializeA2UIExtension(client: A2AClient) {
    const addExtensionHeader = (headers: Headers) => {
      const existingValue = headers.get("X-A2A-Extensions") ?? "";
      const values = existingValue
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      if (!values.includes(A2A_UI_EXTENSION_URI)) {
        values.push(A2A_UI_EXTENSION_URI);
        headers.set("X-A2A-Extensions", values.join(", "));
      }
    };

    const patchFetch = () => {
      const originalFetch = globalThis.fetch;
      if (!originalFetch) {
        return () => {};
      }

      const extensionFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        addExtensionHeader(headers);
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

    const wrapStream = <T>(
      original:
        | ((...args: any[]) => AsyncGenerator<T, void, undefined>)
        | undefined,
    ) => {
      if (!original) {
        return undefined;
      }

      return function wrapped(this: unknown, ...args: unknown[]) {
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
    client.sendMessage = (params) => wrapPromise(() => originalSendMessage(params));

    const originalSendMessageStream = client.sendMessageStream?.bind(client);
    const wrappedSendMessageStream = wrapStream(originalSendMessageStream);
    if (wrappedSendMessageStream) {
      client.sendMessageStream = wrappedSendMessageStream as typeof client.sendMessageStream;
    }

    const originalResubscribeTask = client.resubscribeTask?.bind(client);
    const wrappedResubscribeTask = wrapStream(originalResubscribeTask);
    if (wrappedResubscribeTask) {
      client.resubscribeTask = wrappedResubscribeTask as typeof client.resubscribeTask;
    }
  }
}
