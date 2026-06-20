import {
  AbstractAgent,
  AgentConfig,
  randomUUID,
  EventType,
  type RunAgentInput,
  type BaseEvent,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type StateSnapshotEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type StepStartedEvent,
  type StepFinishedEvent,
  type RawEvent,
  type CustomEvent,
} from "@ag-ui/client";
import { Observable, Subscriber } from "rxjs";

export interface CloudflareAgentsClientConfig extends AgentConfig {
  url: string;
}

interface CloudflareTextChunkEvent {
  type: "TEXT_CHUNK";
  text: string;
  messageId?: string;
}

interface CloudflareToolCallEvent {
  type: "TOOL_CALL";
  toolCallId: string;
  toolName: string;
  args: string;
  parentMessageId?: string;
}

interface CloudflareToolCallResultEvent {
  type: "TOOL_CALL_RESULT";
  toolCallId: string;
  content: string;
}

interface CloudflareStateEvent {
  type: "cf_agent_state";
  state: Record<string, unknown>;
}

interface CloudflareStepEvent {
  type: "STEP_STARTED" | "STEP_FINISHED";
  stepName: string;
}

interface CloudflareCustomEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
}

type CloudflareEvent =
  | CloudflareTextChunkEvent
  | CloudflareToolCallEvent
  | CloudflareToolCallResultEvent
  | CloudflareStateEvent
  | CloudflareStepEvent
  | CloudflareCustomEvent
  | { type: "READY" | "PONG" };

export class CloudflareAgentsClient extends AbstractAgent {
  private cfUrl: string;
  private ws: WebSocket | null = null;
  private currentMessageId: string | null = null;
  private hasErrored = false;

  constructor(config: CloudflareAgentsClientConfig) {
    super(config);
    this.cfUrl = config.url;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber: Subscriber<BaseEvent>) => {
      const wsUrl = this.cfUrl
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:");

      this.hasErrored = false;
      this.currentMessageId = null;

      const onOpen = () => {
        this.ws?.send(
          JSON.stringify({
            type: "INIT",
            threadId: input.threadId,
            runId: input.runId,
            messages: input.messages,
            state: input.state ?? {},
            tools: input.tools ?? [],
            context: input.context ?? [],
            forwardedProps: input.forwardedProps ?? {},
          }),
        );

        const runStarted: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
          timestamp: Date.now(),
          ...(input.parentRunId && { parentRunId: input.parentRunId }),
          input: {
            threadId: input.threadId,
            runId: input.runId,
            messages: input.messages,
            state: input.state ?? {},
            tools: input.tools ?? [],
            context: input.context ?? [],
            forwardedProps: input.forwardedProps ?? {},
            ...(input.parentRunId && { parentRunId: input.parentRunId }),
          },
        };
        subscriber.next(runStarted);
      };

      const onMessage = (event: MessageEvent) => {
        try {
          const data =
            typeof event.data === "string" ? event.data : String(event.data);
          const cfEvent: CloudflareEvent = JSON.parse(data);
          this.handleEvent(cfEvent, input, subscriber);
        } catch (err) {
          this.endCurrentMessage(subscriber);
          this.hasErrored = true;
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: `Failed to parse server message: ${err instanceof Error ? err.message : "Unknown error"}`,
            code: "PARSE_ERROR",
            timestamp: Date.now(),
          } as RunErrorEvent);
          this.ws?.close();
        }
      };

      const onError = (error: Event) => {
        this.hasErrored = true;
        this.endCurrentMessage(subscriber);
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: "WebSocket connection error",
          code: "WS_ERROR",
          timestamp: Date.now(),
        } as RunErrorEvent);
        subscriber.error(error);
      };

      const onClose = () => {
        if (!this.hasErrored) {
          this.endCurrentMessage(subscriber);
          const runFinished: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
            timestamp: Date.now(),
            outcome: { type: "success" },
          };
          subscriber.next(runFinished);
        }
        this.currentMessageId = null;
        subscriber.complete();
      };

      try {
        const WebSocketCtor =
          typeof WebSocket !== "undefined" ? WebSocket : null;

        if (!WebSocketCtor) {
          throw new Error(
            "WebSocket not available. In Node.js, install the 'ws' package.",
          );
        }

        this.ws = new WebSocketCtor(wsUrl);

        if (this.ws.addEventListener) {
          this.ws.addEventListener("open", onOpen);
          this.ws.addEventListener("message", onMessage);
          this.ws.addEventListener("error", onError);
          this.ws.addEventListener("close", onClose);
        } else if ((this.ws as any).on) {
          (this.ws as any).on("open", onOpen);
          (this.ws as any).on("message", onMessage);
          (this.ws as any).on("error", onError);
          (this.ws as any).on("close", onClose);
        }
      } catch (error) {
        subscriber.error(error);
      }

      return () => {
        if (this.ws) {
          if (this.ws.removeEventListener) {
            this.ws.removeEventListener("open", onOpen as EventListener);
            this.ws.removeEventListener("message", onMessage as EventListener);
            this.ws.removeEventListener("error", onError as EventListener);
            this.ws.removeEventListener("close", onClose as EventListener);
          } else if ((this.ws as any).off) {
            (this.ws as any).off("open", onOpen);
            (this.ws as any).off("message", onMessage);
            (this.ws as any).off("error", onError);
            (this.ws as any).off("close", onClose);
          }
          this.ws.close();
          this.ws = null;
        }
        this.currentMessageId = null;
      };
    });
  }

  private handleEvent(
    cfEvent: CloudflareEvent,
    _input: RunAgentInput,
    subscriber: Subscriber<BaseEvent>,
  ): void {
    switch (cfEvent.type) {
      case "TEXT_CHUNK": {
        if (!this.currentMessageId) {
          this.currentMessageId = cfEvent.messageId ?? randomUUID();
          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId: this.currentMessageId,
            role: "assistant",
            timestamp: Date.now(),
          } as TextMessageStartEvent);
        }
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.currentMessageId,
          delta: cfEvent.text,
          timestamp: Date.now(),
        } as TextMessageContentEvent);
        break;
      }

      case "TOOL_CALL": {
        this.endCurrentMessage(subscriber);
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: cfEvent.toolCallId,
          toolCallName: cfEvent.toolName,
          parentMessageId: cfEvent.parentMessageId,
          timestamp: Date.now(),
        } as ToolCallStartEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: cfEvent.toolCallId,
          delta: cfEvent.args,
          timestamp: Date.now(),
        } as ToolCallArgsEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: cfEvent.toolCallId,
          timestamp: Date.now(),
        } as ToolCallEndEvent);
        break;
      }

      case "TOOL_CALL_RESULT": {
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: cfEvent.toolCallId,
          content: cfEvent.content,
          messageId: randomUUID(),
          role: "tool",
          timestamp: Date.now(),
        } as BaseEvent);
        break;
      }

      case "cf_agent_state": {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: cfEvent.state ?? {},
          timestamp: Date.now(),
        } as StateSnapshotEvent);
        break;
      }

      case "STEP_STARTED": {
        subscriber.next({
          type: EventType.STEP_STARTED,
          stepName: cfEvent.stepName,
          timestamp: Date.now(),
        } as StepStartedEvent);
        break;
      }

      case "STEP_FINISHED": {
        subscriber.next({
          type: EventType.STEP_FINISHED,
          stepName: cfEvent.stepName,
          timestamp: Date.now(),
        } as StepFinishedEvent);
        break;
      }

      case "CUSTOM": {
        subscriber.next({
          type: EventType.CUSTOM,
          name: cfEvent.name,
          value: cfEvent.value,
          timestamp: Date.now(),
        } as CustomEvent);
        break;
      }

      case "READY":
      case "PONG":
        break;

      default: {
        subscriber.next({
          type: EventType.RAW,
          event: cfEvent,
          source: "cloudflare-agents",
          timestamp: Date.now(),
        } as RawEvent);
        break;
      }
    }
  }

  private endCurrentMessage(subscriber: Subscriber<BaseEvent>): void {
    if (this.currentMessageId) {
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.currentMessageId,
        timestamp: Date.now(),
      } as TextMessageEndEvent);
      this.currentMessageId = null;
    }
  }

  override abortRun() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    super.abortRun();
  }

  override clone(): CloudflareAgentsClient {
    return new CloudflareAgentsClient({
      agentId: this.agentId,
      description: this.description,
      threadId: this.threadId,
      initialMessages: this.messages,
      initialState: this.state,
      debug: this.debug,
      url: this.cfUrl,
    });
  }
}
