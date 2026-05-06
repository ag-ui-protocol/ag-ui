import { EventType } from "./events";
import { AGUIError } from "./types";
import type {
  ActivityDeltaEvent,
  ActivityDeltaEventProps,
  ActivitySnapshotEvent,
  ActivitySnapshotEventProps,
  CustomEvent,
  CustomEventProps,
  MessagesSnapshotEvent,
  MessagesSnapshotEventProps,
  RawEvent,
  RawEventProps,
  RunErrorEvent,
  RunErrorEventProps,
  RunFinishedEvent,
  RunFinishedEventProps,
  RunStartedEvent,
  RunStartedEventProps,
  StateDeltaEvent,
  StateDeltaEventProps,
  StateSnapshotEvent,
  StateSnapshotEventProps,
  StepFinishedEvent,
  StepFinishedEventProps,
  StepStartedEvent,
  StepStartedEventProps,
  TextMessageChunkEvent,
  TextMessageChunkEventProps,
  TextMessageContentEvent,
  TextMessageContentEventProps,
  TextMessageEndEvent,
  TextMessageEndEventProps,
  TextMessageStartEvent,
  TextMessageStartEventProps,
  ThinkingEndEvent,
  ThinkingEndEventProps,
  ThinkingStartEvent,
  ThinkingStartEventProps,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageContentEventProps,
  ThinkingTextMessageEndEvent,
  ThinkingTextMessageEndEventProps,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageStartEventProps,
  ToolCallArgsEvent,
  ToolCallArgsEventProps,
  ToolCallChunkEvent,
  ToolCallChunkEventProps,
  ToolCallEndEvent,
  ToolCallEndEventProps,
  ToolCallResultEvent,
  ToolCallResultEventProps,
  ToolCallStartEvent,
  ToolCallStartEventProps,
  ReasoningStartEvent,
  ReasoningStartEventProps,
  ReasoningMessageStartEvent,
  ReasoningMessageStartEventProps,
  ReasoningMessageContentEvent,
  ReasoningMessageContentEventProps,
  ReasoningMessageEndEvent,
  ReasoningMessageEndEventProps,
  ReasoningMessageChunkEvent,
  ReasoningMessageChunkEventProps,
  ReasoningEndEvent,
  ReasoningEndEventProps,
  ReasoningEncryptedValueEvent,
  ReasoningEncryptedValueEventProps,
} from "./events";
import type { Interrupt } from "./types";

/** Creates a TEXT_MESSAGE_START event. `role` defaults to `"assistant"` when omitted. */
export const createTextMessageStartEvent = (
  props: TextMessageStartEventProps,
): TextMessageStartEvent =>
  ({
    type: EventType.TEXT_MESSAGE_START,
    ...props,
    role: props.role ?? "assistant",
  }) as TextMessageStartEvent;

/** Creates a TEXT_MESSAGE_CONTENT event. */
export const createTextMessageContentEvent = (
  props: TextMessageContentEventProps,
): TextMessageContentEvent =>
  ({ type: EventType.TEXT_MESSAGE_CONTENT, ...props }) as TextMessageContentEvent;

/** Creates a TEXT_MESSAGE_END event. */
export const createTextMessageEndEvent = (
  props: TextMessageEndEventProps,
): TextMessageEndEvent =>
  ({ type: EventType.TEXT_MESSAGE_END, ...props }) as TextMessageEndEvent;

/** Creates a TEXT_MESSAGE_CHUNK event. */
export const createTextMessageChunkEvent = (
  props: TextMessageChunkEventProps,
): TextMessageChunkEvent =>
  ({ type: EventType.TEXT_MESSAGE_CHUNK, ...props }) as TextMessageChunkEvent;

/** @deprecated Use `createReasoningMessageStartEvent` instead. Will be removed in 1.0.0. */
export const createThinkingTextMessageStartEvent = (
  props: ThinkingTextMessageStartEventProps,
): ThinkingTextMessageStartEvent =>
  ({
    type: EventType.THINKING_TEXT_MESSAGE_START,
    ...props,
  }) as ThinkingTextMessageStartEvent;

/** @deprecated Use `createReasoningMessageContentEvent` instead. Will be removed in 1.0.0. */
export const createThinkingTextMessageContentEvent = (
  props: ThinkingTextMessageContentEventProps,
): ThinkingTextMessageContentEvent =>
  ({
    type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
    ...props,
  }) as ThinkingTextMessageContentEvent;

/** @deprecated Use `createReasoningMessageEndEvent` instead. Will be removed in 1.0.0. */
export const createThinkingTextMessageEndEvent = (
  props: ThinkingTextMessageEndEventProps,
): ThinkingTextMessageEndEvent =>
  ({
    type: EventType.THINKING_TEXT_MESSAGE_END,
    ...props,
  }) as ThinkingTextMessageEndEvent;

/** Creates a TOOL_CALL_START event. */
export const createToolCallStartEvent = (
  props: ToolCallStartEventProps,
): ToolCallStartEvent =>
  ({ type: EventType.TOOL_CALL_START, ...props }) as ToolCallStartEvent;

/** Creates a TOOL_CALL_ARGS event. */
export const createToolCallArgsEvent = (
  props: ToolCallArgsEventProps,
): ToolCallArgsEvent =>
  ({ type: EventType.TOOL_CALL_ARGS, ...props }) as ToolCallArgsEvent;

/** Creates a TOOL_CALL_END event. */
export const createToolCallEndEvent = (
  props: ToolCallEndEventProps,
): ToolCallEndEvent =>
  ({ type: EventType.TOOL_CALL_END, ...props }) as ToolCallEndEvent;

/** Creates a TOOL_CALL_CHUNK event. */
export const createToolCallChunkEvent = (
  props: ToolCallChunkEventProps,
): ToolCallChunkEvent =>
  ({ type: EventType.TOOL_CALL_CHUNK, ...props }) as ToolCallChunkEvent;

/** Creates a TOOL_CALL_RESULT event. */
export const createToolCallResultEvent = (
  props: ToolCallResultEventProps,
): ToolCallResultEvent =>
  ({ type: EventType.TOOL_CALL_RESULT, ...props }) as ToolCallResultEvent;

/** @deprecated Use `createReasoningStartEvent` instead. Will be removed in 1.0.0. */
export const createThinkingStartEvent = (
  props: ThinkingStartEventProps,
): ThinkingStartEvent =>
  ({ type: EventType.THINKING_START, ...props }) as ThinkingStartEvent;

/** @deprecated Use `createReasoningEndEvent` instead. Will be removed in 1.0.0. */
export const createThinkingEndEvent = (
  props: ThinkingEndEventProps,
): ThinkingEndEvent =>
  ({ type: EventType.THINKING_END, ...props }) as ThinkingEndEvent;

/** Creates a STATE_SNAPSHOT event. */
export const createStateSnapshotEvent = (
  props: StateSnapshotEventProps,
): StateSnapshotEvent =>
  ({ type: EventType.STATE_SNAPSHOT, ...props }) as StateSnapshotEvent;

/** Creates a STATE_DELTA event. */
export const createStateDeltaEvent = (
  props: StateDeltaEventProps,
): StateDeltaEvent =>
  ({ type: EventType.STATE_DELTA, ...props }) as StateDeltaEvent;

/** Creates a MESSAGES_SNAPSHOT event. */
export const createMessagesSnapshotEvent = (
  props: MessagesSnapshotEventProps,
): MessagesSnapshotEvent =>
  ({ type: EventType.MESSAGES_SNAPSHOT, ...props }) as MessagesSnapshotEvent;

/** Creates an ACTIVITY_SNAPSHOT event. `replace` defaults to `true` when omitted. */
export const createActivitySnapshotEvent = (
  props: ActivitySnapshotEventProps,
): ActivitySnapshotEvent =>
  ({
    type: EventType.ACTIVITY_SNAPSHOT,
    ...props,
    replace: props.replace ?? true,
  }) as ActivitySnapshotEvent;

/** Creates an ACTIVITY_DELTA event. */
export const createActivityDeltaEvent = (
  props: ActivityDeltaEventProps,
): ActivityDeltaEvent =>
  ({ type: EventType.ACTIVITY_DELTA, ...props }) as ActivityDeltaEvent;

/** Creates a RAW event. */
export const createRawEvent = (props: RawEventProps): RawEvent =>
  ({
    type: EventType.RAW,
    ...props,
  }) as RawEvent;

/** Creates a CUSTOM event. */
export const createCustomEvent = (props: CustomEventProps): CustomEvent =>
  ({
    type: EventType.CUSTOM,
    ...props,
  }) as CustomEvent;

/** Creates a RUN_STARTED event. */
export const createRunStartedEvent = (
  props: RunStartedEventProps,
): RunStartedEvent =>
  ({ type: EventType.RUN_STARTED, ...props }) as RunStartedEvent;

/**
 * Creates a RUN_FINISHED event. `outcome` is optional; pass `{ type: "success" }` or
 * `{ type: "interrupt", interrupts }` (or use the convenience helpers below).
 *
 * `outcome: null` is normalized to `outcome` being omitted.
 */
export const createRunFinishedEvent = (
  props: RunFinishedEventProps,
): RunFinishedEvent => {
  const { outcome, ...rest } = props;
  const event: RunFinishedEvent = { type: EventType.RUN_FINISHED, ...rest } as RunFinishedEvent;
  if (outcome !== null && outcome !== undefined) {
    event.outcome = outcome as RunFinishedEvent["outcome"];
  }
  return event;
};

/** Creates a RUN_FINISHED event with `outcome: { type: "success" }`. */
export const createRunFinishedSuccessEvent = (
  props: Omit<RunFinishedEventProps, "outcome">,
): RunFinishedEvent =>
  createRunFinishedEvent({ ...props, outcome: { type: "success" } });

/**
 * Creates a RUN_FINISHED event with `outcome: { type: "interrupt", interrupts }`.
 * Throws if `interrupts` is empty.
 */
export const createRunFinishedInterruptEvent = (
  props: Omit<RunFinishedEventProps, "outcome"> & { interrupts: Interrupt[] },
): RunFinishedEvent => {
  const { interrupts, ...rest } = props;
  if (!interrupts || interrupts.length === 0) {
    throw new AGUIError("interrupts array must contain at least one element");
  }
  return createRunFinishedEvent({
    ...rest,
    outcome: { type: "interrupt", interrupts },
  });
};

/** Creates a RUN_ERROR event. */
export const createRunErrorEvent = (props: RunErrorEventProps): RunErrorEvent =>
  ({
    type: EventType.RUN_ERROR,
    ...props,
  }) as RunErrorEvent;

/** Creates a STEP_STARTED event. */
export const createStepStartedEvent = (
  props: StepStartedEventProps,
): StepStartedEvent =>
  ({ type: EventType.STEP_STARTED, ...props }) as StepStartedEvent;

/** Creates a STEP_FINISHED event. */
export const createStepFinishedEvent = (
  props: StepFinishedEventProps,
): StepFinishedEvent =>
  ({ type: EventType.STEP_FINISHED, ...props }) as StepFinishedEvent;

/** Creates a REASONING_START event. */
export const createReasoningStartEvent = (
  props: ReasoningStartEventProps,
): ReasoningStartEvent =>
  ({ type: EventType.REASONING_START, ...props }) as ReasoningStartEvent;

/** Creates a REASONING_MESSAGE_START event. */
export const createReasoningMessageStartEvent = (
  props: ReasoningMessageStartEventProps,
): ReasoningMessageStartEvent =>
  ({ type: EventType.REASONING_MESSAGE_START, ...props }) as ReasoningMessageStartEvent;

/** Creates a REASONING_MESSAGE_CONTENT event. */
export const createReasoningMessageContentEvent = (
  props: ReasoningMessageContentEventProps,
): ReasoningMessageContentEvent =>
  ({ type: EventType.REASONING_MESSAGE_CONTENT, ...props }) as ReasoningMessageContentEvent;

/** Creates a REASONING_MESSAGE_END event. */
export const createReasoningMessageEndEvent = (
  props: ReasoningMessageEndEventProps,
): ReasoningMessageEndEvent =>
  ({ type: EventType.REASONING_MESSAGE_END, ...props }) as ReasoningMessageEndEvent;

/** Creates a REASONING_MESSAGE_CHUNK event. */
export const createReasoningMessageChunkEvent = (
  props: ReasoningMessageChunkEventProps,
): ReasoningMessageChunkEvent =>
  ({ type: EventType.REASONING_MESSAGE_CHUNK, ...props }) as ReasoningMessageChunkEvent;

/** Creates a REASONING_END event. */
export const createReasoningEndEvent = (
  props: ReasoningEndEventProps,
): ReasoningEndEvent =>
  ({ type: EventType.REASONING_END, ...props }) as ReasoningEndEvent;

/** Creates a REASONING_ENCRYPTED_VALUE event. */
export const createReasoningEncryptedValueEvent = (
  props: ReasoningEncryptedValueEventProps,
): ReasoningEncryptedValueEvent =>
  ({ type: EventType.REASONING_ENCRYPTED_VALUE, ...props }) as ReasoningEncryptedValueEvent;
