import { z } from "zod";
import {
  ActivityDeltaEvent,
  ActivityDeltaEventProps,
  ActivityDeltaEventSchema,
  ActivitySnapshotEvent,
  ActivitySnapshotEventProps,
  ActivitySnapshotEventSchema,
  CustomEvent,
  CustomEventProps,
  CustomEventSchema,
  EventType,
  MessagesSnapshotEvent,
  MessagesSnapshotEventProps,
  MessagesSnapshotEventSchema,
  RawEvent,
  RawEventProps,
  RawEventSchema,
  RunErrorEvent,
  RunErrorEventProps,
  RunErrorEventSchema,
  RunFinishedEvent,
  RunFinishedEventProps,
  RunFinishedEventSchema,
  RunStartedEvent,
  RunStartedEventProps,
  RunStartedEventSchema,
  StateDeltaEvent,
  StateDeltaEventProps,
  StateDeltaEventSchema,
  StateSnapshotEvent,
  StateSnapshotEventProps,
  StateSnapshotEventSchema,
  StepFinishedEvent,
  StepFinishedEventProps,
  StepFinishedEventSchema,
  StepStartedEvent,
  StepStartedEventProps,
  StepStartedEventSchema,
  TextMessageChunkEvent,
  TextMessageChunkEventProps,
  TextMessageChunkEventSchema,
  TextMessageContentEvent,
  TextMessageContentEventProps,
  TextMessageContentEventSchema,
  TextMessageEndEvent,
  TextMessageEndEventProps,
  TextMessageEndEventSchema,
  TextMessageStartEvent,
  TextMessageStartEventProps,
  TextMessageStartEventSchema,
  ThinkingEndEvent,
  ThinkingEndEventProps,
  ThinkingEndEventSchema,
  ThinkingStartEvent,
  ThinkingStartEventProps,
  ThinkingStartEventSchema,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageContentEventProps,
  ThinkingTextMessageContentEventSchema,
  ThinkingTextMessageEndEvent,
  ThinkingTextMessageEndEventProps,
  ThinkingTextMessageEndEventSchema,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageStartEventProps,
  ThinkingTextMessageStartEventSchema,
  ToolCallArgsEvent,
  ToolCallArgsEventProps,
  ToolCallArgsEventSchema,
  ToolCallChunkEvent,
  ToolCallChunkEventProps,
  ToolCallChunkEventSchema,
  ToolCallEndEvent,
  ToolCallEndEventProps,
  ToolCallEndEventSchema,
  ToolCallResultEvent,
  ToolCallResultEventProps,
  ToolCallResultEventSchema,
  ToolCallStartEvent,
  ToolCallStartEventProps,
  ToolCallStartEventSchema,
} from "./events";

const buildEvent = <Schema extends z.ZodTypeAny>(
  eventType: EventType,
  schema: Schema,
  props: Omit<z.input<Schema>, "type">,
): z.infer<Schema> =>
  schema.parse({
    type: eventType,
    ...props,
  });

/**
 * Creates a TEXT_MESSAGE_START event.
 */
export const createTextMessageStartEvent = (
  props: TextMessageStartEventProps,
): TextMessageStartEvent =>
  buildEvent(EventType.TEXT_MESSAGE_START, TextMessageStartEventSchema, props);

/**
 * Creates a TEXT_MESSAGE_CONTENT event.
 */
export const createTextMessageContentEvent = (
  props: TextMessageContentEventProps,
): TextMessageContentEvent =>
  buildEvent(EventType.TEXT_MESSAGE_CONTENT, TextMessageContentEventSchema, props);

/**
 * Creates a TEXT_MESSAGE_END event.
 */
export const createTextMessageEndEvent = (props: TextMessageEndEventProps): TextMessageEndEvent =>
  buildEvent(EventType.TEXT_MESSAGE_END, TextMessageEndEventSchema, props);

/**
 * Creates a TEXT_MESSAGE_CHUNK event.
 */
export const createTextMessageChunkEvent = (
  props: TextMessageChunkEventProps,
): TextMessageChunkEvent =>
  buildEvent(EventType.TEXT_MESSAGE_CHUNK, TextMessageChunkEventSchema, props);

/**
 * Creates a THINKING_TEXT_MESSAGE_START event.
 */
export const createThinkingTextMessageStartEvent = (
  props: ThinkingTextMessageStartEventProps,
): ThinkingTextMessageStartEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_START, ThinkingTextMessageStartEventSchema, props);

/**
 * Creates a THINKING_TEXT_MESSAGE_CONTENT event.
 */
export const createThinkingTextMessageContentEvent = (
  props: ThinkingTextMessageContentEventProps,
): ThinkingTextMessageContentEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_CONTENT, ThinkingTextMessageContentEventSchema, props);

/**
 * Creates a THINKING_TEXT_MESSAGE_END event.
 */
export const createThinkingTextMessageEndEvent = (
  props: ThinkingTextMessageEndEventProps,
): ThinkingTextMessageEndEvent =>
  buildEvent(EventType.THINKING_TEXT_MESSAGE_END, ThinkingTextMessageEndEventSchema, props);

/**
 * Creates a TOOL_CALL_START event.
 */
export const createToolCallStartEvent = (props: ToolCallStartEventProps): ToolCallStartEvent =>
  buildEvent(EventType.TOOL_CALL_START, ToolCallStartEventSchema, props);

/**
 * Creates a TOOL_CALL_ARGS event.
 */
export const createToolCallArgsEvent = (props: ToolCallArgsEventProps): ToolCallArgsEvent =>
  buildEvent(EventType.TOOL_CALL_ARGS, ToolCallArgsEventSchema, props);

/**
 * Creates a TOOL_CALL_END event.
 */
export const createToolCallEndEvent = (props: ToolCallEndEventProps): ToolCallEndEvent =>
  buildEvent(EventType.TOOL_CALL_END, ToolCallEndEventSchema, props);

/**
 * Creates a TOOL_CALL_CHUNK event.
 */
export const createToolCallChunkEvent = (props: ToolCallChunkEventProps): ToolCallChunkEvent =>
  buildEvent(EventType.TOOL_CALL_CHUNK, ToolCallChunkEventSchema, props);

/**
 * Creates a TOOL_CALL_RESULT event.
 */
export const createToolCallResultEvent = (props: ToolCallResultEventProps): ToolCallResultEvent =>
  buildEvent(EventType.TOOL_CALL_RESULT, ToolCallResultEventSchema, props);

/**
 * Creates a THINKING_START event.
 */
export const createThinkingStartEvent = (props: ThinkingStartEventProps): ThinkingStartEvent =>
  buildEvent(EventType.THINKING_START, ThinkingStartEventSchema, props);

/**
 * Creates a THINKING_END event.
 */
export const createThinkingEndEvent = (props: ThinkingEndEventProps): ThinkingEndEvent =>
  buildEvent(EventType.THINKING_END, ThinkingEndEventSchema, props);

/**
 * Creates a STATE_SNAPSHOT event.
 */
export const createStateSnapshotEvent = (props: StateSnapshotEventProps): StateSnapshotEvent =>
  buildEvent(EventType.STATE_SNAPSHOT, StateSnapshotEventSchema, props);

/**
 * Creates a STATE_DELTA event.
 */
export const createStateDeltaEvent = (props: StateDeltaEventProps): StateDeltaEvent =>
  buildEvent(EventType.STATE_DELTA, StateDeltaEventSchema, props);

/**
 * Creates a MESSAGES_SNAPSHOT event.
 */
export const createMessagesSnapshotEvent = (
  props: MessagesSnapshotEventProps,
): MessagesSnapshotEvent =>
  buildEvent(EventType.MESSAGES_SNAPSHOT, MessagesSnapshotEventSchema, props);

/**
 * Creates an ACTIVITY_SNAPSHOT event.
 */
export const createActivitySnapshotEvent = (
  props: ActivitySnapshotEventProps,
): ActivitySnapshotEvent =>
  buildEvent(EventType.ACTIVITY_SNAPSHOT, ActivitySnapshotEventSchema, props);

/**
 * Creates an ACTIVITY_DELTA event.
 */
export const createActivityDeltaEvent = (props: ActivityDeltaEventProps): ActivityDeltaEvent =>
  buildEvent(EventType.ACTIVITY_DELTA, ActivityDeltaEventSchema, props);

/**
 * Creates a RAW event.
 */
export const createRawEvent = (props: RawEventProps): RawEvent =>
  buildEvent(EventType.RAW, RawEventSchema, props);

/**
 * Creates a CUSTOM event.
 */
export const createCustomEvent = (props: CustomEventProps): CustomEvent =>
  buildEvent(EventType.CUSTOM, CustomEventSchema, props);

/**
 * Creates a RUN_STARTED event.
 */
export const createRunStartedEvent = (props: RunStartedEventProps): RunStartedEvent =>
  buildEvent(EventType.RUN_STARTED, RunStartedEventSchema, props);

/**
 * Creates a RUN_FINISHED event.
 */
export const createRunFinishedEvent = (props: RunFinishedEventProps): RunFinishedEvent =>
  buildEvent(EventType.RUN_FINISHED, RunFinishedEventSchema, props);

/**
 * Creates a RUN_ERROR event.
 */
export const createRunErrorEvent = (props: RunErrorEventProps): RunErrorEvent =>
  buildEvent(EventType.RUN_ERROR, RunErrorEventSchema, props);

/**
 * Creates a STEP_STARTED event.
 */
export const createStepStartedEvent = (props: StepStartedEventProps): StepStartedEvent =>
  buildEvent(EventType.STEP_STARTED, StepStartedEventSchema, props);

/**
 * Creates a STEP_FINISHED event.
 */
export const createStepFinishedEvent = (props: StepFinishedEventProps): StepFinishedEvent =>
  buildEvent(EventType.STEP_FINISHED, StepFinishedEventSchema, props);
