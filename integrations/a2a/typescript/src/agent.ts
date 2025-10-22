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
import type { MessageSendConfiguration, MessageSendParams, Message as A2AMessage } from "@a2a-js/sdk";
import { convertAGUIMessagesToA2A, convertA2AEventToAGUIEvents } from "./utils";
import type { A2AAgentRunResultSummary, ConvertedA2AMessages, A2AStreamEvent } from "./types";
import { randomUUID } from "@ag-ui/client";

export interface A2AAgentConfig extends AgentConfig {
  agentUrl?: string;
  client?: A2AClient;
}

export class A2AAgent extends AbstractAgent {
  private readonly agentUrl?: string;
  private readonly client: A2AClient;
  private readonly messageIdMap = new Map<string, string>();

  constructor(config: A2AAgentConfig) {
    const { agentUrl, client, ...rest } = config;

    if (!agentUrl && !client) {
      throw new Error("A2AAgent requires either an agentUrl or a preconfigured A2AClient.");
    }

    super(rest);

    this.agentUrl = agentUrl;
    this.client = client ?? new A2AClient(agentUrl!);
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
            summary = await this.fallbackToBlocking(sendParams, subscriber, error as Error);
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

    const metadata = {
      agui: {
        threadId: input.threadId,
        runId: input.runId,
        history: converted.history,
      },
    } as Record<string, unknown>;

    return {
      message,
      configuration,
      metadata,
    } as MessageSendParams;
  }

  private async streamMessage(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
  ): Promise<A2AAgentRunResultSummary> {
    const aggregatedText = new Map<string, string>();
    const rawEvents: A2AStreamEvent[] = [];

    const stream = this.client.sendMessageStream(params);
    for await (const chunk of stream) {
      rawEvents.push(chunk as A2AStreamEvent);
      const events = convertA2AEventToAGUIEvents(chunk as A2AStreamEvent, {
        role: "assistant",
        messageIdMap: this.messageIdMap,
        onTextDelta: ({ messageId, delta }) => {
          aggregatedText.set(messageId, (aggregatedText.get(messageId) ?? "") + delta);
        },
        source: this.agentUrl ?? "a2a",
      });
      for (const event of events) {
        subscriber.next(event);
      }
    }

    return {
      messages: Array.from(aggregatedText.entries()).map(([messageId, text]) => ({ messageId, text })),
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
      acceptedOutputModes: params.configuration?.acceptedOutputModes ?? ["text"],
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
    const response = await this.client.sendMessage(params);

    if (this.client.isErrorResponse(response)) {
      const errorMessage = response.error?.message ?? "Unknown error from A2A agent";
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
        aggregatedText.set(messageId, (aggregatedText.get(messageId) ?? "") + delta);
      },
      source: this.agentUrl ?? "a2a",
    });

    for (const event of events) {
      subscriber.next(event);
    }

    return {
      messages: Array.from(aggregatedText.entries()).map(([messageId, text]) => ({ messageId, text })),
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
}
