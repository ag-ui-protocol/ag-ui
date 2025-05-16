import { z } from "zod";
import { MessageSchema, StateSchema } from "./types";

export enum EventType {
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
  TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK",
  TOOL_CALL_START = "TOOL_CALL_START",
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
  TOOL_CALL_END = "TOOL_CALL_END",
  TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK",
  STATE_SNAPSHOT = "STATE_SNAPSHOT",
  STATE_DELTA = "STATE_DELTA",
  MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT",
  RAW = "RAW",
  CUSTOM = "CUSTOM",
  RUN_STARTED = "RUN_STARTED",
  RUN_FINISHED = "RUN_FINISHED",
  RUN_ERROR = "RUN_ERROR",
  STEP_STARTED = "STEP_STARTED",
  STEP_FINISHED = "STEP_FINISHED",
}

const BaseEventSchema = z.object({
  type: z.nativeEnum(EventType),
  timestamp: z.number().optional(),
  rawEvent: z.any().optional(),
});

export const RunStartedSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_STARTED),
  threadId: z.string(),
  runId: z.string(),
});

export const RunFinishedSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_FINISHED),
  threadId: z.string(),
  runId: z.string(),
});

export const RunErrorSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_ERROR),
  message: z.string(),
  code: z.string().optional(),
});

export const StepStartedSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_STARTED),
  stepName: z.string(),
});

export const StepFinishedSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_FINISHED),
  stepName: z.string(),
});

export const TextMessageStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: z.literal("assistant"),
});

export const TextMessageContentEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string().refine((s) => s.length > 0, "Delta must not be an empty string"),
});

export const TextMessageEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_END),
  messageId: z.string(),
});

export const TextMessageChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TEXT_MESSAGE_CHUNK),
  messageId: z.string().optional(),
  role: z.literal("assistant").optional(),
  delta: z.string().optional(),
});

export const ToolCallStartEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_START),
  toolCallId: z.string(),
  toolCallName: z.string(),
  parentMessageId: z.string().optional(),
});

export const ToolCallArgsEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_ARGS),
  toolCallId: z.string(),
  delta: z.string(),
});

export const ToolCallEndEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_END),
  toolCallId: z.string(),
});

export const ToolCallChunkEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.TOOL_CALL_CHUNK),
  toolCallId: z.string().optional(),
  toolCallName: z.string().optional(),
  parentMessageId: z.string().optional(),
  delta: z.string().optional(),
});

export const StateSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_SNAPSHOT),
  snapshot: StateSchema,
});

export const StateDeltaEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STATE_DELTA),
  delta: z.array(z.any()), // JSON Patch (RFC 6902)
});

export const MessagesSnapshotEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.MESSAGES_SNAPSHOT),
  messages: z.array(MessageSchema),
});

export const RawEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RAW),
  event: z.any(),
  source: z.string().optional(),
});

export const CustomEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.CUSTOM),
  name: z.string(),
  value: z.any(),
});

export const RunStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_STARTED),
  threadId: z.string(),
  runId: z.string(),
});

export const RunFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_FINISHED),
  threadId: z.string(),
  runId: z.string(),
});

export const RunErrorEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.RUN_ERROR),
  message: z.string(),
  code: z.string().optional(),
});

export const StepStartedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_STARTED),
  stepName: z.string(),
});

export const StepFinishedEventSchema = BaseEventSchema.extend({
  type: z.literal(EventType.STEP_FINISHED),
  stepName: z.string(),
});

export const EventSchemas = z.discriminatedUnion("type", [
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageChunkEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallChunkEventSchema,
  StateSnapshotEventSchema,
  StateDeltaEventSchema,
  MessagesSnapshotEventSchema,
  RawEventSchema,
  CustomEventSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunErrorEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
]);

export type BaseEvent = z.infer<typeof BaseEventSchema>;
export type TextMessageStartEvent = z.infer<typeof TextMessageStartEventSchema>;
export type TextMessageContentEvent = z.infer<typeof TextMessageContentEventSchema>;
export type TextMessageEndEvent = z.infer<typeof TextMessageEndEventSchema>;
export type TextMessageChunkEvent = z.infer<typeof TextMessageChunkEventSchema>;
export type ToolCallStartEvent = z.infer<typeof ToolCallStartEventSchema>;
export type ToolCallArgsEvent = z.infer<typeof ToolCallArgsEventSchema>;
export type ToolCallEndEvent = z.infer<typeof ToolCallEndEventSchema>;
export type ToolCallChunkEvent = z.infer<typeof ToolCallChunkEventSchema>;
export type StateSnapshotEvent = z.infer<typeof StateSnapshotEventSchema>;
export type StateDeltaEvent = z.infer<typeof StateDeltaEventSchema>;
export type MessagesSnapshotEvent = z.infer<typeof MessagesSnapshotEventSchema>;
export type RawEvent = z.infer<typeof RawEventSchema>;
export type CustomEvent = z.infer<typeof CustomEventSchema>;
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type RunFinishedEvent = z.infer<typeof RunFinishedEventSchema>;
export type RunErrorEvent = z.infer<typeof RunErrorEventSchema>;
export type StepStartedEvent = z.infer<typeof StepStartedEventSchema>;
export type StepFinishedEvent = z.infer<typeof StepFinishedEventSchema>;
