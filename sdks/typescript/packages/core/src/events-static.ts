// Hand-written equivalents of the z.infer<...> event types in events.ts.
// This file will replace the type definitions in events.ts once zod is removed
// from @ag-ui/core. Until then, both files coexist and equality is verified
// in __tests__/types-static.test.ts.

import type { Message, RunAgentInput, Interrupt } from "./types-static";
import { EventType } from "./events";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type TextMessageRole = "developer" | "system" | "assistant" | "user";

export type ReasoningEncryptedValueSubtype = "tool-call" | "message";

// ---------------------------------------------------------------------------
// BaseEvent
// ---------------------------------------------------------------------------

export interface BaseEvent {
  type: EventType;
  timestamp?: number;
  rawEvent?: any;
}

// Alias kept for parity with events.ts
export type BaseEventFields = BaseEvent;

// ---------------------------------------------------------------------------
// Text-message events
// ---------------------------------------------------------------------------

export interface TextMessageStartEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_START;
  messageId: string;
  // .default("assistant") means z.infer gives non-optional TextMessageRole
  role: TextMessageRole;
  name?: string;
}

export interface TextMessageContentEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_END;
  messageId: string;
}

export interface TextMessageChunkEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_CHUNK;
  messageId?: string;
  role?: TextMessageRole;
  delta?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Deprecated Thinking events (aliased to Reasoning counterparts in 1.0.0)
// ---------------------------------------------------------------------------

/** @deprecated Use ReasoningTextMessageStartEvent instead. Will be removed in 1.0.0. */
export interface ThinkingTextMessageStartEvent extends BaseEvent {
  type: EventType.THINKING_TEXT_MESSAGE_START;
}

/** @deprecated Use ReasoningMessageContentEvent instead. Will be removed in 1.0.0. */
export interface ThinkingTextMessageContentEvent extends BaseEvent {
  type: EventType.THINKING_TEXT_MESSAGE_CONTENT;
  // ThinkingTextMessageContentEventSchema omits messageId from TextMessageContentEventSchema
  delta: string;
}

/** @deprecated Use ReasoningMessageEndEvent instead. Will be removed in 1.0.0. */
export interface ThinkingTextMessageEndEvent extends BaseEvent {
  type: EventType.THINKING_TEXT_MESSAGE_END;
}

// ---------------------------------------------------------------------------
// Tool-call events
// ---------------------------------------------------------------------------

export interface ToolCallStartEvent extends BaseEvent {
  type: EventType.TOOL_CALL_START;
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
  type: EventType.TOOL_CALL_ARGS;
  toolCallId: string;
  delta: string;
}

export interface ToolCallEndEvent extends BaseEvent {
  type: EventType.TOOL_CALL_END;
  toolCallId: string;
}

export interface ToolCallResultEvent extends BaseEvent {
  messageId: string;
  type: EventType.TOOL_CALL_RESULT;
  toolCallId: string;
  content: string;
  role?: "tool";
}

export interface ToolCallChunkEvent extends BaseEvent {
  type: EventType.TOOL_CALL_CHUNK;
  toolCallId?: string;
  toolCallName?: string;
  parentMessageId?: string;
  delta?: string;
}

// ---------------------------------------------------------------------------
// Deprecated Thinking start/end
// ---------------------------------------------------------------------------

/** @deprecated Use ReasoningStartEvent instead. Will be removed in 1.0.0. */
export interface ThinkingStartEvent extends BaseEvent {
  type: EventType.THINKING_START;
  title?: string;
}

/** @deprecated Use ReasoningEndEvent instead. Will be removed in 1.0.0. */
export interface ThinkingEndEvent extends BaseEvent {
  type: EventType.THINKING_END;
}

// ---------------------------------------------------------------------------
// State / message snapshot events
// ---------------------------------------------------------------------------

export interface StateSnapshotEvent extends BaseEvent {
  type: EventType.STATE_SNAPSHOT;
  snapshot: any;
}

export interface StateDeltaEvent extends BaseEvent {
  type: EventType.STATE_DELTA;
  delta: any[];
}

export interface MessagesSnapshotEvent extends BaseEvent {
  type: EventType.MESSAGES_SNAPSHOT;
  messages: Message[];
}

export interface ActivitySnapshotEvent extends BaseEvent {
  type: EventType.ACTIVITY_SNAPSHOT;
  messageId: string;
  activityType: string;
  content: Record<string, any>;
  // .optional().default(true) — z.infer OUTPUT is boolean (not optional)
  replace: boolean;
}

export interface ActivityDeltaEvent extends BaseEvent {
  type: EventType.ACTIVITY_DELTA;
  messageId: string;
  activityType: string;
  patch: any[];
}

// ---------------------------------------------------------------------------
// Raw / Custom events
// ---------------------------------------------------------------------------

export interface RawEvent extends BaseEvent {
  type: EventType.RAW;
  event: any;
  source?: string;
}

export interface CustomEvent extends BaseEvent {
  type: EventType.CUSTOM;
  name: string;
  value: any;
}

// ---------------------------------------------------------------------------
// Run lifecycle events
// ---------------------------------------------------------------------------

export interface RunStartedEvent extends BaseEvent {
  type: EventType.RUN_STARTED;
  threadId: string;
  runId: string;
  parentRunId?: string;
  input?: RunAgentInput;
}

export interface RunFinishedSuccessOutcome {
  type: "success";
}

export interface RunFinishedInterruptOutcome {
  type: "interrupt";
  interrupts: [Interrupt, ...Interrupt[]];
}

export type RunFinishedOutcome = RunFinishedSuccessOutcome | RunFinishedInterruptOutcome;

export interface RunFinishedEvent extends BaseEvent {
  type: EventType.RUN_FINISHED;
  threadId: string;
  runId: string;
  result?: any;
  // nullable().optional().transform(v => v ?? undefined) → output is RunFinishedOutcome | undefined
  outcome?: RunFinishedOutcome;
}

export interface RunErrorEvent extends BaseEvent {
  type: EventType.RUN_ERROR;
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Step events
// ---------------------------------------------------------------------------

export interface StepStartedEvent extends BaseEvent {
  type: EventType.STEP_STARTED;
  stepName: string;
}

export interface StepFinishedEvent extends BaseEvent {
  type: EventType.STEP_FINISHED;
  stepName: string;
}

// ---------------------------------------------------------------------------
// Reasoning events
// ---------------------------------------------------------------------------

export interface ReasoningStartEvent extends BaseEvent {
  type: EventType.REASONING_START;
  messageId: string;
}

export interface ReasoningMessageStartEvent extends BaseEvent {
  type: EventType.REASONING_MESSAGE_START;
  messageId: string;
  role: "reasoning";
}

export interface ReasoningMessageContentEvent extends BaseEvent {
  type: EventType.REASONING_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
}

export interface ReasoningMessageEndEvent extends BaseEvent {
  type: EventType.REASONING_MESSAGE_END;
  messageId: string;
}

export interface ReasoningMessageChunkEvent extends BaseEvent {
  type: EventType.REASONING_MESSAGE_CHUNK;
  messageId?: string;
  delta?: string;
}

export interface ReasoningEndEvent extends BaseEvent {
  type: EventType.REASONING_END;
  messageId: string;
}

export interface ReasoningEncryptedValueEvent extends BaseEvent {
  type: EventType.REASONING_ENCRYPTED_VALUE;
  subtype: ReasoningEncryptedValueSubtype;
  entityId: string;
  encryptedValue: string;
}

// ---------------------------------------------------------------------------
// AGUIEvent discriminated union
// ---------------------------------------------------------------------------

export type AGUIEvent =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | TextMessageChunkEvent
  | ThinkingStartEvent
  | ThinkingEndEvent
  | ThinkingTextMessageStartEvent
  | ThinkingTextMessageContentEvent
  | ThinkingTextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallChunkEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | ActivitySnapshotEvent
  | ActivityDeltaEvent
  | RawEvent
  | CustomEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningMessageChunkEvent
  | ReasoningEndEvent
  | ReasoningEncryptedValueEvent;

// ---------------------------------------------------------------------------
// AGUIEventByType mapped type
// ---------------------------------------------------------------------------

export type AGUIEventByType = {
  [EventType.TEXT_MESSAGE_START]: TextMessageStartEvent;
  [EventType.TEXT_MESSAGE_CONTENT]: TextMessageContentEvent;
  [EventType.TEXT_MESSAGE_END]: TextMessageEndEvent;
  [EventType.TEXT_MESSAGE_CHUNK]: TextMessageChunkEvent;
  [EventType.THINKING_TEXT_MESSAGE_START]: ThinkingTextMessageStartEvent;
  [EventType.THINKING_TEXT_MESSAGE_CONTENT]: ThinkingTextMessageContentEvent;
  [EventType.THINKING_TEXT_MESSAGE_END]: ThinkingTextMessageEndEvent;
  [EventType.TOOL_CALL_START]: ToolCallStartEvent;
  [EventType.TOOL_CALL_ARGS]: ToolCallArgsEvent;
  [EventType.TOOL_CALL_END]: ToolCallEndEvent;
  [EventType.TOOL_CALL_CHUNK]: ToolCallChunkEvent;
  [EventType.TOOL_CALL_RESULT]: ToolCallResultEvent;
  [EventType.THINKING_START]: ThinkingStartEvent;
  [EventType.THINKING_END]: ThinkingEndEvent;
  [EventType.STATE_SNAPSHOT]: StateSnapshotEvent;
  [EventType.STATE_DELTA]: StateDeltaEvent;
  [EventType.MESSAGES_SNAPSHOT]: MessagesSnapshotEvent;
  [EventType.ACTIVITY_SNAPSHOT]: ActivitySnapshotEvent;
  [EventType.ACTIVITY_DELTA]: ActivityDeltaEvent;
  [EventType.RAW]: RawEvent;
  [EventType.CUSTOM]: CustomEvent;
  [EventType.RUN_STARTED]: RunStartedEvent;
  [EventType.RUN_FINISHED]: RunFinishedEvent;
  [EventType.RUN_ERROR]: RunErrorEvent;
  [EventType.STEP_STARTED]: StepStartedEvent;
  [EventType.STEP_FINISHED]: StepFinishedEvent;
  [EventType.REASONING_START]: ReasoningStartEvent;
  [EventType.REASONING_MESSAGE_START]: ReasoningMessageStartEvent;
  [EventType.REASONING_MESSAGE_CONTENT]: ReasoningMessageContentEvent;
  [EventType.REASONING_MESSAGE_END]: ReasoningMessageEndEvent;
  [EventType.REASONING_MESSAGE_CHUNK]: ReasoningMessageChunkEvent;
  [EventType.REASONING_END]: ReasoningEndEvent;
  [EventType.REASONING_ENCRYPTED_VALUE]: ReasoningEncryptedValueEvent;
};

export type AGUIEventOf<T extends EventType> = AGUIEventByType[T];
export type EventPayloadOf<T extends EventType> = Omit<AGUIEventOf<T>, keyof BaseEventFields>;

// ---------------------------------------------------------------------------
// Props types (mirror z.input<Schema> with "type" omitted)
// Fields with .default() are optional in Props (callers can omit them)
// ---------------------------------------------------------------------------

export type BaseEventProps = Omit<BaseEvent, "type">;

// TextMessageStartEvent: role has .default("assistant") → optional in Props
export type TextMessageStartEventProps = Omit<TextMessageStartEvent, "type" | "role"> & {
  role?: TextMessageRole;
};
export type TextMessageContentEventProps = Omit<TextMessageContentEvent, "type">;
export type TextMessageEndEventProps = Omit<TextMessageEndEvent, "type">;
export type TextMessageChunkEventProps = Omit<TextMessageChunkEvent, "type">;

export type ThinkingTextMessageStartEventProps = Omit<ThinkingTextMessageStartEvent, "type">;
export type ThinkingTextMessageContentEventProps = Omit<ThinkingTextMessageContentEvent, "type">;
export type ThinkingTextMessageEndEventProps = Omit<ThinkingTextMessageEndEvent, "type">;

export type ToolCallStartEventProps = Omit<ToolCallStartEvent, "type">;
export type ToolCallArgsEventProps = Omit<ToolCallArgsEvent, "type">;
export type ToolCallEndEventProps = Omit<ToolCallEndEvent, "type">;
export type ToolCallChunkEventProps = Omit<ToolCallChunkEvent, "type">;
export type ToolCallResultEventProps = Omit<ToolCallResultEvent, "type">;

export type ThinkingStartEventProps = Omit<ThinkingStartEvent, "type">;
export type ThinkingEndEventProps = Omit<ThinkingEndEvent, "type">;

export type StateSnapshotEventProps = Omit<StateSnapshotEvent, "type">;
export type StateDeltaEventProps = Omit<StateDeltaEvent, "type">;
export type MessagesSnapshotEventProps = Omit<MessagesSnapshotEvent, "type">;

// ActivitySnapshotEvent: replace has .optional().default(true) → optional in Props
export type ActivitySnapshotEventProps = Omit<ActivitySnapshotEvent, "type" | "replace"> & {
  replace?: boolean;
};
export type ActivityDeltaEventProps = Omit<ActivityDeltaEvent, "type">;

export type RawEventProps = Omit<RawEvent, "type">;
export type CustomEventProps = Omit<CustomEvent, "type">;

export type RunStartedEventProps = Omit<RunStartedEvent, "type">;
export type RunFinishedEventProps = Omit<RunFinishedEvent, "type">;
export type RunErrorEventProps = Omit<RunErrorEvent, "type">;

export type StepStartedEventProps = Omit<StepStartedEvent, "type">;
export type StepFinishedEventProps = Omit<StepFinishedEvent, "type">;

export type ReasoningStartEventProps = Omit<ReasoningStartEvent, "type">;
export type ReasoningMessageStartEventProps = Omit<ReasoningMessageStartEvent, "type">;
export type ReasoningMessageContentEventProps = Omit<ReasoningMessageContentEvent, "type">;
export type ReasoningMessageEndEventProps = Omit<ReasoningMessageEndEvent, "type">;
export type ReasoningMessageChunkEventProps = Omit<ReasoningMessageChunkEvent, "type">;
export type ReasoningEndEventProps = Omit<ReasoningEndEvent, "type">;
export type ReasoningEncryptedValueEventProps = Omit<ReasoningEncryptedValueEvent, "type">;
