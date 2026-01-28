/**
 * Type definitions for AG-UI Claude SDK integration.
 * 
 * Only defines types specific to this adapter.
 * For SDK types, import directly from @anthropic-ai/claude-agent-sdk or @anthropic-ai/sdk.
 */

import type { AgentConfig } from "@ag-ui/client";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Configuration for ClaudeAgentAdapter.
 * Combines AG-UI AgentConfig with Claude SDK Options.
 * 
 * @example
 * ```typescript
 * const config: ClaudeAgentAdapterConfig = {
 *   model: "claude-sonnet-4-20250514",
 *   permissionMode: "acceptEdits",
 *   allowedTools: ["Read", "Write"],
 * };
 * ```
 */
export type ClaudeAgentAdapterConfig = AgentConfig & Options & {
  /** Anthropic API key (falls back to ANTHROPIC_API_KEY env var) */
  apiKey?: string;
};
