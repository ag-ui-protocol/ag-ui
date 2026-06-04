import { AssistantGraph, Message as LangGraphMessage } from "@langchain/langgraph-sdk";
import { MessageType } from "@langchain/core/messages";
import {
  CustomEvent,
  MessagesSnapshotEvent,
  RawEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ToolCallResultEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
} from "@ag-ui/client";

export enum LangGraphEventTypes {
  OnChainStart = "on_chain_start",
  OnChainStream = "on_chain_stream",
  OnChainEnd = "on_chain_end",
  OnChatModelStart = "on_chat_model_start",
  OnChatModelStream = "on_chat_model_stream",
  OnChatModelEnd = "on_chat_model_end",
  OnToolStart = "on_tool_start",
  OnToolEnd = "on_tool_end",
  OnToolError = "on_tool_error",
  OnCustomEvent = "on_custom_event",
  OnInterrupt = "on_interrupt",
}

export type LangGraphToolWithName = {
  type: "function";
  name?: string;
  function: {
    name: string;
    description: string;
    parameters: any;
  },
}

export type State<TDefinedState = Record<string, any>> = {
  [k in keyof TDefinedState]: TDefinedState[k] | null;
} & Record<string, any>;
export interface StateEnrichment {
  messages: LangGraphMessage[];
  tools: LangGraphToolWithName[];
  'ag-ui': {
    tools: LangGraphToolWithName[];
    context: RunAgentInput['context']
  }
}

export type SchemaKeys = {
  input: string[] | null;
  output: string[] | null;
  context: string[] | null;
  config: string[] | null;
} | null;

export type MessageInProgress = {
  id: string;
  toolCallId?: string | null;
  toolCallName?: string | null;
  textMessage?: boolean;
};

export type ReasoningInProgress = {
  index: number;
  type?: LangGraphReasoning['type'];
  messageId: string;
  signature?: string;
}

// Per-content-block tracking for v3 messages-channel translation.
// Lives on RunMetadata so it resets cleanly between runs (activeRun is
// replaced wholesale on each runAgentStream).
export interface TextBlockState {
  messageId: string;
}

export interface ToolBlockState {
  toolCallId: string;
  toolCallName: string;
  argsSoFar: string;
}

export interface ReasoningBlockState {
  messageId: string;
  messageStarted: boolean;
}

export interface RunMetadata {
  id: string;
  schemaKeys?: SchemaKeys;
  nodeName?: string;
  prevNodeName?: string | null;
  exitingNode?: boolean;
  manuallyEmittedState?: State | null;
  threadId?: string;
  graphInfo?: AssistantGraph
  hasFunctionStreaming?: boolean;
  // True once the platform-assigned run id is known (set from stream metadata)
  serverRunIdKnown?: boolean;
  // Set true when a tool call matching a predict_state entry is detected in
  // the chat model stream. Remains true through tool arg streaming and tool
  // execution; cleared in OnToolEnd/OnToolError. While set, STATE_SNAPSHOT
  // emission is suppressed so optimistic UI state is not overwritten.
  modelMadeToolCall?: boolean;
  // True when the connected server speaks the v3 streaming protocol
  // (the `/threads/:id/stream/events` route exists). Decided once per
  // run via an OPTIONS probe and used to route between the v3 and
  // legacy event bundles. Undefined until probed.
  isV3?: boolean;
  // v3 messages-channel translation state.
  // Indexed by content-block index inside the LangGraph protocol message.
  activeMessageId?: string;
  textBlockMessageIds: Map<number, string>;
  toolBlocks: Map<number, ToolBlockState>;
  reasoningBlocks: Map<number, ReasoningBlockState>;
}

// v3 messages-channel event payload. Shape mirrors what
// `aguiTransformer` consumes from `event.params.data` on the
// "messages" channel. Fields are optional because the same envelope
// carries every sub-event ("message-start" / "content-block-start" /
// "content-block-delta" / "content-block-finish" / "message-finish" /
// "message-error" / "usage").
export interface V3MessageEventContentBlock {
  type?: string;
  reasoning?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  args?: string;
}

export interface V3MessageEventDelta {
  type?: string;
  text?: string;
  reasoning?: string;
  thinking?: string;
  fields?: {
    name?: string;
    args?: string;
  };
}

export interface V3MessageEvent {
  event:
    | "message-start"
    | "content-block-start"
    | "content-block-delta"
    | "content-block-finish"
    | "message-finish"
    | "message-error"
    | "usage";
  role?: string;
  id?: string;
  index?: number;
  content?: V3MessageEventContentBlock;
  delta?: V3MessageEventDelta;
}

// v3 `tools`-channel event payload (params.data). The langgraph runtime
// normalises tool execution lifecycle into this discriminated shape
// (see the SDK's convertToolsPayload). Fields are per-discriminant:
//   tool-started      → tool_name, input
//   tool-output-delta → delta
//   tool-finished     → output
//   tool-error        → message
export interface V3ToolsEvent {
  event: "tool-started" | "tool-output-delta" | "tool-finished" | "tool-error";
  tool_call_id: string;
  tool_name?: string;
  input?: unknown;
  delta?: string;
  output?: unknown;
  message?: string;
}

export type MessagesInProgressRecord = Record<string, MessageInProgress | null>;

// The following types are our own definition to the messages accepted by LangGraph Platform, enhanced with some of our extra data.
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type BaseLangGraphPlatformMessage = Omit<
  LangGraphMessage,
  | "isResultMessage"
  | "isTextMessage"
  | "isImageMessage"
  | "isActionExecutionMessage"
  | "isAgentStateMessage"
  | "type"
  | "createdAt"
> & {
  content: string;
  role: string;
  additional_kwargs?: Record<string, unknown>;
  type: MessageType;
};

interface LangGraphPlatformResultMessage extends BaseLangGraphPlatformMessage {
  tool_call_id: string;
  name: string;
}

interface LangGraphPlatformActionExecutionMessage extends BaseLangGraphPlatformMessage {
  tool_calls: ToolCall[];
}

export type LangGraphPlatformMessage =
  | LangGraphPlatformActionExecutionMessage
  | LangGraphPlatformResultMessage
  | BaseLangGraphPlatformMessage;

export enum CustomEventNames {
  ManuallyEmitMessage = "manually_emit_message",
  ManuallyEmitToolCall = "manually_emit_tool_call",
  ManuallyEmitState = "manually_emit_state",
  Exit = "exit",
}

export interface PredictStateTool {
  tool: string;
  state_key: string;
  tool_argument: string;
}

export interface LangGraphReasoning {
  type: 'text';
  text: string;
  index: number;
  signature?: string;
}

export type ProcessedEvents =
    | TextMessageStartEvent
    | TextMessageContentEvent
    | TextMessageEndEvent
    | ReasoningStartEvent
    | ReasoningMessageStartEvent
    | ReasoningMessageContentEvent
    | ReasoningMessageEndEvent
    | ReasoningEndEvent
    | ReasoningEncryptedValueEvent
    | ToolCallStartEvent
    | ToolCallArgsEvent
    | ToolCallEndEvent
    | ToolCallResultEvent
    | StateSnapshotEvent
    | StateDeltaEvent
    | MessagesSnapshotEvent
    | RawEvent
    | CustomEvent
    | RunStartedEvent
    | RunFinishedEvent
    | RunErrorEvent
    | StepStartedEvent
    | StepFinishedEvent;