/**
 * Type definitions for AG-UI Claude SDK integration.
 *
 * Only defines types specific to this adapter.
 * For SDK types, import directly from @anthropic-ai/claude-agent-sdk or @anthropic-ai/sdk.
 */

import type { AgentConfig } from "@ag-ui/client";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
  ThinkingStartEvent,
  ThinkingEndEvent,
  StateSnapshotEvent,
  MessagesSnapshotEvent,
  CustomEvent,
} from "@ag-ui/core";

/**
 * Configuration for ClaudeAgentAdapter.
 * Combines AG-UI AgentConfig with Claude SDK Options.
 *
 * AgentConfig provides: agentId (maps to Python's "name"), description
 * Options provides: model, systemPrompt, mcpServers, allowedTools, etc.
 *
 * The adapter is a thin protocol translator -- it does not manage the SDK
 * client lifecycle or API keys. Set ANTHROPIC_API_KEY via environment variable
 * or pass it directly when creating the query stream.
 *
 * @example
 * ```typescript
 * const config: ClaudeAgentAdapterConfig = {
 *   agentId: "my_agent",
 *   description: "A helpful assistant",
 *   model: "claude-haiku-4-5",
 *   systemPrompt: "You are helpful",
 *   permissionMode: "acceptEdits",
 *   allowedTools: ["Read", "Write"],
 * };
 * ```
 */
export type ClaudeAgentAdapterConfig = AgentConfig & Options;

/**
 * Union of all AG-UI event types this adapter can emit.
 */
export type ProcessedEvent =
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
  | ThinkingTextMessageStartEvent
  | ThinkingTextMessageContentEvent
  | ThinkingTextMessageEndEvent
  | ThinkingStartEvent
  | ThinkingEndEvent
  | StateSnapshotEvent
  | MessagesSnapshotEvent
  | CustomEvent;
