import {
  BaseEvent,
  Message,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  State,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  MessagesSnapshotEvent,
  RawEvent,
  CustomEvent,
  ToolCall,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ActivityMessage,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
} from "@ag-ui/core";
import { AbstractAgent } from "./agent";
import { structuredClone_ } from "@/utils";

export interface AgentStateMutation {
  messages?: Message[];
  state?: State;
  stopPropagation?: boolean;
}

export interface AgentSubscriberParams {
  messages: ReadonlyArray<Readonly<Message>>;
  // NOTE: State resolves to `any` at the type level (z.infer<typeof z.any()>), so Readonly<State>
  // provides no compile-time mutation protection. Runtime enforcement via deepFreeze in
  // dev/test mode is the only guard against in-place mutation of state.
  state: Readonly<State>;
  agent: AbstractAgent;
  input: RunAgentInput;
}

// Utility type to allow callbacks to be implemented either synchronously or asynchronously.
export type MaybePromise<T> = T | Promise<T>;

export interface AgentSubscriber {
  // Request lifecycle
  onRunInitialized?(
    params: AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onRunFailed?(
    params: { error: Error } & AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
  onRunFinalized?(
    params: AgentSubscriberParams,
  ): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;

  // Events
  onEvent?(
    params: { event: BaseEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onRunStartedEvent?(
    params: { event: RunStartedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunFinishedEvent?(
    params: { event: RunFinishedEvent; result?: any } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onRunErrorEvent?(
    params: { event: RunErrorEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onStepStartedEvent?(
    params: { event: StepStartedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onStepFinishedEvent?(
    params: { event: StepFinishedEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onTextMessageStartEvent?(
    params: { event: TextMessageStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageContentEvent?(
    params: {
      event: TextMessageContentEvent;
      textMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onTextMessageEndEvent?(
    params: { event: TextMessageEndEvent; textMessageBuffer: string } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onToolCallStartEvent?(
    params: { event: ToolCallStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallArgsEvent?(
    params: {
      event: ToolCallArgsEvent;
      toolCallBuffer: string;
      toolCallName: string;
      partialToolCallArgs: Record<string, any>;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;
  onToolCallEndEvent?(
    params: {
      event: ToolCallEndEvent;
      toolCallName: string;
      toolCallArgs: Record<string, any>;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onToolCallResultEvent?(
    params: { event: ToolCallResultEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onStateSnapshotEvent?(
    params: { event: StateSnapshotEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onStateDeltaEvent?(
    params: { event: StateDeltaEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onMessagesSnapshotEvent?(
    params: { event: MessagesSnapshotEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onActivitySnapshotEvent?(
    params: {
      event: ActivitySnapshotEvent;
      activityMessage?: ActivityMessage;
      existingMessage?: Message;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onActivityDeltaEvent?(
    params: {
      event: ActivityDeltaEvent;
      activityMessage?: ActivityMessage;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onRawEvent?(
    params: { event: RawEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onCustomEvent?(
    params: { event: CustomEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  // Reasoning events
  onReasoningStartEvent?(
    params: { event: ReasoningStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningMessageStartEvent?(
    params: { event: ReasoningMessageStartEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningMessageContentEvent?(
    params: {
      event: ReasoningMessageContentEvent;
      reasoningMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningMessageEndEvent?(
    params: {
      event: ReasoningMessageEndEvent;
      reasoningMessageBuffer: string;
    } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningEndEvent?(
    params: { event: ReasoningEndEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  onReasoningEncryptedValueEvent?(
    params: { event: ReasoningEncryptedValueEvent } & AgentSubscriberParams,
  ): MaybePromise<AgentStateMutation | void>;

  // State changes
  onMessagesChanged?(
    params: Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput },
  ): MaybePromise<void>;
  onStateChanged?(
    params: Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput },
  ): MaybePromise<void>;
  onNewMessage?(
    params: { message: Message } & Omit<AgentSubscriberParams, "input"> & {
        input?: RunAgentInput;
      },
  ): MaybePromise<void>;
  onNewToolCall?(
    params: { toolCall: ToolCall } & Omit<AgentSubscriberParams, "input"> & {
        input?: RunAgentInput;
      },
  ): MaybePromise<void>;
}

function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj)) {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
  }
  return obj;
}

export async function runSubscribersWithMutation(
  subscribers: AgentSubscriber[],
  initialMessages: Message[],
  initialState: State,
  executor: (
    subscriber: AgentSubscriber,
    messages: ReadonlyArray<Readonly<Message>>,
    state: Readonly<State>,
  ) => MaybePromise<AgentStateMutation | void>,
): Promise<AgentStateMutation> {
  const isTestEnvironment =
    process.env.NODE_ENV === "test" || Boolean(process.env.VITEST_WORKER_ID);
  const isDev =
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" ||
    Boolean(process.env.VITEST_WORKER_ID);
  const baselineMessages = structuredClone_(initialMessages);
  const baselineState = structuredClone_(initialState);
  let messages: Message[] = baselineMessages;
  let state: State = baselineState;

  let stopPropagation: boolean | undefined = undefined;

  for (const subscriber of subscribers) {
    try {
      // Subscribers receive shared references and must not mutate them in-place.
      // Mutations should only be communicated via the return value.
      // In dev/test mode only: deep-freeze inputs so accidental in-place mutations surface
      // as TypeErrors immediately. In production, enforcement is type-level only.
      if (isDev) {
        deepFreeze(messages);
        deepFreeze(state);
      }
      const mutation = await executor(subscriber, messages, state);

      if (mutation === undefined) {
        // Nothing returned – keep going
        continue;
      }

      // Replace with a defensive copy of the subscriber's mutation,
      // but skip if the subscriber returned the same reference (no-op).
      if (mutation.messages !== undefined && mutation.messages !== messages) {
        messages = structuredClone_(mutation.messages);
      }

      if (mutation.state !== undefined && mutation.state !== state) {
        state = structuredClone_(mutation.state);
      }

      stopPropagation = mutation.stopPropagation;

      if (stopPropagation === true) {
        break;
      }
    } catch (error) {
      if (isDev && error instanceof TypeError) {
        // Likely a freeze violation: subscriber attempted to mutate frozen inputs in-place.
        // In test environments, re-throw so tests fail fast and the violation is visible.
        // In development (non-test), log a specific message to distinguish freeze violations
        // from ordinary subscriber errors.
        if (isTestEnvironment) {
          throw error;
        }
        console.error(
          "AG-UI: Subscriber attempted to mutate frozen inputs in-place. " +
            "Return mutations via AgentStateMutation instead of mutating directly.",
          error,
        );
      } else if (!isTestEnvironment) {
        console.error("Subscriber error:", error);
      }
      // Skip this subscriber's mutation and continue
      continue;
    }
  }

  // In dev/test mode, the canonical messages/state references may have been
  // frozen in-place (for subscriber mutation detection). Clone them before
  // returning so callers receive a mutable copy, not a frozen one.
  return {
    ...(messages !== baselineMessages
      ? { messages: isDev && Object.isFrozen(messages) ? structuredClone_(messages) : messages }
      : {}),
    ...(state !== baselineState
      ? { state: isDev && Object.isFrozen(state) ? structuredClone_(state) : state }
      : {}),
    ...(stopPropagation !== undefined ? { stopPropagation } : {}),
  };
}
