import { Message } from "@langchain/langgraph-sdk";
import { MessageType } from "@langchain/core/messages";

export enum LangGraphEventTypes {
  OnChainStart = "on_chain_start",
  OnChainStream = "on_chain_stream",
  OnChainEnd = "on_chain_end",
  OnChatModelStart = "on_chat_model_start",
  OnChatModelStream = "on_chat_model_stream",
  OnChatModelEnd = "on_chat_model_end",
  OnToolStart = "on_tool_start",
  OnToolEnd = "on_tool_end",
  OnCustomEvent = "on_custom_event",
  OnInterrupt = "on_interrupt",
}

export type State = Record<string, any>;

export type SchemaKeys = {
  input: string[] | null;
  output: string[] | null;
  config: string[] | null;
} | null;

export type MessageInProgress = {
  id: string;
  toolCallId?: string | null;
  toolCallName?: string | null;
};

export interface RunMetadata {
  id: string;
  schemaKeys?: SchemaKeys;
  nodeName?: string;
  prevNodeName?: string | null;
  exitingNode?: boolean;
  manuallyEmittedState?: State | null;
  threadId?: string;
}

export type MessagesInProgressRecord = Record<string, MessageInProgress | null>;

// The following types are our own definition to the messages accepted by LangGraph Platform, enhanced with some of our extra data.
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type BaseLangGraphPlatformMessage = Omit<
  Message,
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
