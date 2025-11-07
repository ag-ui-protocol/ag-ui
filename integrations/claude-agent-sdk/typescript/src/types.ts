/**
 * Type definitions for Claude Agent SDK integration with AG-UI Protocol
 */

import type {
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  AgentConfig,
  Tool,
  Message,
} from '@ag-ui/client';

// Re-export Claude SDK types (will be imported from the actual SDK)
// These are placeholder interfaces based on the SDK documentation
export interface ClaudeSDKClient {
  query(prompt: string): Promise<void>;
  receiveResponse(): AsyncIterableIterator<SDKMessage>;
  close(): Promise<void>;
}

export interface Options {
  apiKey?: string;
  baseUrl?: string;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools?: string[];
  permissionMode?: 'ask' | 'auto' | 'none';
  [key: string]: any;
}

export interface Query {
  next(): Promise<IteratorResult<SDKMessage, void>>;
  [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage>;
}

// SDK Message types based on documentation
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKSystemMessage
  | SDKResultMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKPermissionDenial;

export interface SDKAssistantMessage {
  type: 'assistant';
  content: ContentBlock[];
  id?: string;
}

export interface SDKUserMessage {
  type: 'user';
  content: string;
  id?: string;
}

export interface SDKSystemMessage {
  type: 'system';
  content: string;
}

export interface SDKResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  error?: {
    type: string;
    message: string;
  };
}

export interface SDKPartialAssistantMessage {
  type: 'partial_assistant';
  content: ContentBlock[];
}

export interface SDKCompactBoundaryMessage {
  type: 'compact_boundary';
}

export interface SDKPermissionDenial {
  type: 'permission_denial';
  tool: string;
  reason: string;
}

// Content block types
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; [key: string]: any }>;
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

// Tool definition types
export interface SdkMcpToolDefinition<Schema = any> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: any, extra?: any) => Promise<CallToolResult>;
}

export interface CallToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: any;
  }>;
  isError?: boolean;
}

export interface McpSdkServerConfigWithInstance {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}

// AG-UI Integration types
export type ProcessedEvents =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent;

// Session management types
export interface Session {
  id: string;
  userId?: string;
  client?: ClaudeSDKClient;
  processedMessageIds: Set<string>;
  state: Record<string, any>;
  createdAt: number;
  lastAccessedAt: number;
}

// Agent configuration
export interface ClaudeAgentConfig extends AgentConfig {
  apiKey?: string;
  baseUrl?: string;
  sessionTimeout?: number;
  enablePersistentSessions?: boolean;
  permissionMode?: 'ask' | 'auto' | 'none';
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
}

// Execution state types
export interface ExecutionState {
  id: string;
  sessionId: string;
  isRunning: boolean;
  startTime: number;
  events: ProcessedEvents[];
  error?: Error;
}

// Helper type guards
export function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === 'assistant';
}

export function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

export function hasContentProperty(message: SDKMessage): message is SDKAssistantMessage | SDKPartialAssistantMessage {
  return 'content' in message && Array.isArray(message.content);
}

// Tool execution types
export interface ToolExecutionContext {
  toolName: string;
  toolCallId: string;
  isClientTool: boolean;
  isLongRunning: boolean;
}

// Message conversion types
export interface ConvertedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; [key: string]: any }>;
}

