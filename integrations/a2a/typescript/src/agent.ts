import {
  AbstractAgent,
  AgentConfig,
  BaseEvent,
  EventType,
  PROTOCOL_VERSION,
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
  Part as A2APart,
} from "@a2a-js/sdk";
import { convertAGUIMessagesToA2A, convertA2AEventToAGUIEvents } from "./utils";
import type {
  A2AAgentRunResultSummary,
  ConvertedA2AMessages,
  A2AStreamEvent,
  SurfaceTracker,
} from "./types";
import { randomUUID, structuredClone_ } from "@ag-ui/client";

export interface A2AAgentConfig extends AgentConfig {
  a2aClient: A2AClient;
  /**
   * Headers sent on every A2A request, mirroring HttpAgent.headers. Runtimes
   * that clone the agent once per request (e.g. CopilotKit's runtime, which
   * forwards the caller's Authorization header) write the per-request headers
   * onto the clone; they are read back at call time, never stored on the
   * shared A2AClient, so one request's headers cannot leak into another's.
   */
  headers?: Record<string, string>;
}

const EXTENSION_URI = "https://a2ui.org/a2a-extension/a2ui/v0.8";
const A2A_UI_MIME_TYPE = "application/json+a2ui";

function addExtensionHeader(headers: Headers) {
  const existingValue = headers.get("X-A2A-Extensions") ?? "";
  const values = existingValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!values.includes(EXTENSION_URI)) {
    values.push(EXTENSION_URI);
    headers.set("X-A2A-Extensions", values.join(", "));
  }
}

export class A2AAgent extends AbstractAgent {
  private readonly a2aClient: A2AClient;
  private readonly messageIdMap = new Map<string, string>();
  public headers: Record<string, string>;

  constructor(config: A2AAgentConfig) {
    const { a2aClient, headers, ...rest } = config;
    if (!a2aClient) {
      throw new Error("A2AAgent requires a configured A2AClient instance.");
    }

    super(rest);

    this.a2aClient = a2aClient;
    this.headers = structuredClone_(headers ?? {});
  }

  /**
   * Keeps the base agent's state (thread, messages, subscribers), the shared
   * client, and this agent's headers. The shared client is never mutated:
   * per-call headers are applied by the call itself (see installHeaderFetch),
   * so cloning is safe to do once per request.
   */
  clone(): A2AAgent {
    const cloned = super.clone() as A2AAgent;
    const fields = cloned as unknown as {
      a2aClient: A2AClient;
      messageIdMap: Map<string, string>;
      headers: Record<string, string>;
    };
    fields.a2aClient = this.a2aClient;
    fields.messageIdMap = new Map();
    fields.headers = structuredClone_(this.headers ?? {});
    return cloned;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        const runStarted: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
          protocolVersion: PROTOCOL_VERSION,
        };
        subscriber.next(runStarted);

        if (!input.messages?.length) {
          const runFinished: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
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
            } as unknown as RunFinishedEvent;
            subscriber.next(runFinished);
            subscriber.complete();
            return;
          }

          const sendParams = await this.createSendParams(converted, input);

          const surfaceTracker = this.createSurfaceTracker();

          try {
            await this.streamMessage(sendParams, subscriber, surfaceTracker);
          } catch (error) {
            await this.fallbackToBlocking(
              sendParams,
              subscriber,
              error as Error,
              surfaceTracker,
            );
          }

          const runFinished: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
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
    const converted = convertAGUIMessagesToA2A(input.messages ?? [], {
      contextId: input.threadId,
    });

    this.attachForwardedAction(converted, input.forwardedProps);

    return converted;
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
    surfaceTracker?: SurfaceTracker,
  ): Promise<A2AAgentRunResultSummary> {
    const aggregatedText = new Map<string, string>();
    const rawEvents: A2AStreamEvent[] = [];
    const tracker = surfaceTracker ?? this.createSurfaceTracker();

    const restoreFetch = this.installHeaderFetch();
    try {
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
          source: "a2a",
          surfaceTracker: tracker,
        });
        for (const event of events) {
          subscriber.next(event);
        }
      }
    } finally {
      restoreFetch();
    }

    return {
      messages: [],
      rawEvents,
    };
  }

  private async fallbackToBlocking(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
    error: Error,
    surfaceTracker?: SurfaceTracker,
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
      surfaceTracker,
    );
  }

  private async blockingMessage(
    params: MessageSendParams,
    subscriber: { next: (event: BaseEvent) => void },
    surfaceTracker?: SurfaceTracker,
  ): Promise<A2AAgentRunResultSummary> {
    const restoreFetch = this.installHeaderFetch();
    let response: Awaited<ReturnType<A2AClient["sendMessage"]>>;
    try {
      response = await this.a2aClient.sendMessage(params);
    } finally {
      restoreFetch();
    }

    if (this.a2aClient.isErrorResponse(response)) {
      const errorMessage =
        response.error?.message ?? "Unknown error from A2A agent";
      console.error("A2A sendMessage error", response.error);
      throw new Error(errorMessage);
    }

    const aggregatedText = new Map<string, string>();
    const rawEvents: A2AStreamEvent[] = [];
    const tracker = surfaceTracker ?? this.createSurfaceTracker();

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
      source: "a2a",
      surfaceTracker: tracker,
    });

    for (const event of events) {
      subscriber.next(event);
    }

    return {
      messages: [],
      rawEvents,
    };
  }

  /**
   * Installs, for the duration of a single call only, a fetch that merges
   * this agent's own headers (read at call time, so a per-request clone's
   * headers are the ones sent) plus the A2UI extension header into every
   * request, then restores the previous fetch. Returns the restore function;
   * callers run it in a finally block.
   *
   * Why this shape: the pinned @a2a-js/sdk client (0.2.x) takes no fetchImpl
   * option and no per-call options — its methods call the bare global fetch.
   * So a call-scoped fetch is the only seam that can carry per-clone headers
   * without writing anything onto the shared client. The shared client itself
   * is never mutated, and nothing here persists past the call. Overlapping
   * runs in one process still share the global fetch slot while both are in
   * flight (pre-existing limitation, also noted in #3208); a fix that removes
   * the global slot entirely needs an SDK with a per-call fetch channel.
   */
  private installHeaderFetch(): () => void {
    const originalFetch = globalThis.fetch;
    if (!originalFetch) {
      return () => {};
    }

    const agentHeaders = this.headers ?? {};
    const headerFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(agentHeaders)) {
        headers.set(name, value);
      }
      addExtensionHeader(headers);
      const nextInit: RequestInit = {
        ...init,
        headers,
      };
      return originalFetch(input, nextInit);
    };

    globalThis.fetch = headerFetch;

    return () => {
      globalThis.fetch = originalFetch;
    };
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

  private attachForwardedAction(
    converted: ConvertedA2AMessages,
    forwardedProps: unknown,
  ) {
    if (
      !forwardedProps ||
      typeof forwardedProps !== "object" ||
      !converted.latestUserMessage
    ) {
      return;
    }

    const { a2uiAction } = forwardedProps as {
      a2uiAction?: unknown;
    };

    if (
      !a2uiAction ||
      typeof a2uiAction !== "object" ||
      !("userAction" in a2uiAction)
    ) {
      return;
    }

    const target = converted.latestUserMessage;
    const existingParts = Array.isArray(target.parts) ? [...target.parts] : [];

    const actionPart = {
      kind: "data",
      data: a2uiAction as Record<string, unknown>,
      mimeType: A2A_UI_MIME_TYPE,
    } as A2APart;

    existingParts.push(actionPart);
    target.parts = existingParts;

    const historyIndex = converted.history.findIndex(
      (message) => message.messageId === target.messageId,
    );

    if (historyIndex >= 0) {
      converted.history[historyIndex] = target;
    }
  }
}
