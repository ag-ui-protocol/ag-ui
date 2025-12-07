export type Role = "user" | "assistant" | "tool" | "system";

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  function: ToolCallFunction;
}

export interface TextMessageContent {
  type: "text";
  text: string;
}

export interface BinaryMessageContent {
  type: "binary";
  mimeType: string;
  data?: string;
  url?: string;
  id?: string;
  filename?: string;
}

export type MessageContent =
  | string
  | Array<
      | TextMessageContent
      | BinaryMessageContent
      | { text?: string; [key: string]: unknown }
      | string
      | number
      | boolean
      | null
      | undefined
    >;

export interface BaseMessage {
  role: Role;
  content?: MessageContent;
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  tool_calls?: ToolCall[];
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  toolCallId?: string;
  tool_call_id?: string;
}

export type AgentMessage = AssistantMessage | ToolMessage | BaseMessage;

export interface RunAgentInput {
  thread_id?: string | null;
  threadId?: string | null;
  run_id?: string | null;
  runId?: string | null;
  state?: Record<string, unknown> | null;
  messages?: AgentMessage[];
  tools?: Array<
    | string
    | {
        name?: string;
        tool_name?: string;
        [key: string]: unknown;
      }
  >;
}

export enum EventType {
  RUN_STARTED = "RUN_STARTED",
  RUN_FINISHED = "RUN_FINISHED",
  RUN_ERROR = "RUN_ERROR",
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
  TOOL_CALL_START = "TOOL_CALL_START",
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
  TOOL_CALL_END = "TOOL_CALL_END",
  TOOL_CALL_RESULT = "TOOL_CALL_RESULT",
  STATE_SNAPSHOT = "STATE_SNAPSHOT",
  MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT",
  CUSTOM = "CUSTOM",
}

export interface BaseEvent {
  type: EventType;
}

export interface RunStartedEvent extends BaseEvent {
  type: EventType.RUN_STARTED;
  threadId?: string | null;
  runId?: string | null;
}

export interface RunFinishedEvent extends BaseEvent {
  type: EventType.RUN_FINISHED;
  threadId?: string | null;
  runId?: string | null;
}

export interface RunErrorEvent extends BaseEvent {
  type: EventType.RUN_ERROR;
  message: string;
  code?: string;
}

export interface TextMessageStartEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_START;
  messageId: string;
  message_id?: string;
  role: Role;
}

export interface TextMessageContentEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_CONTENT;
  messageId: string;
  message_id?: string;
  delta: string;
}

export interface TextMessageEndEvent extends BaseEvent {
  type: EventType.TEXT_MESSAGE_END;
  messageId: string;
  message_id?: string;
}

export interface ToolCallStartEvent extends BaseEvent {
  type: EventType.TOOL_CALL_START;
  toolCallId: string;
  tool_call_id?: string;
  toolCallName?: string;
  tool_call_name?: string;
  parentMessageId?: string;
  parent_message_id?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
  type: EventType.TOOL_CALL_ARGS;
  toolCallId: string;
  tool_call_id?: string;
  delta: string;
}

export interface ToolCallEndEvent extends BaseEvent {
  type: EventType.TOOL_CALL_END;
  toolCallId: string;
  tool_call_id?: string;
}

export interface ToolCallResultEvent extends BaseEvent {
  type: EventType.TOOL_CALL_RESULT;
  toolCallId: string;
  tool_call_id?: string;
  messageId: string;
  message_id?: string;
  content: string;
  role?: "tool";
}

export interface StateSnapshotEvent extends BaseEvent {
  type: EventType.STATE_SNAPSHOT;
  snapshot: Record<string, unknown>;
}

export interface MessagesSnapshotEvent extends BaseEvent {
  type: EventType.MESSAGES_SNAPSHOT;
  messages: AgentMessage[];
}

export interface CustomEvent extends BaseEvent {
  type: EventType.CUSTOM;
  name: string;
  value: unknown;
}

export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | MessagesSnapshotEvent
  | CustomEvent;
