/**
 * Configuration constants for Claude Agent SDK adapter.
 *
 * Defines whitelists, defaults, and configuration options.
 */

/**
 * Whitelist of forwardedProps keys that can be applied as per-run option overrides.
 * These are runtime execution controls, not agent identity/security settings.
 *
 * Uses camelCase to match the TS Claude Agent SDK Options type.
 */
export const ALLOWED_FORWARDED_PROPS = new Set<string>([
  // Session control
  "resume", // Session ID to resume
  "forkSession", // Fork vs continue session
  "resumeSessionAt", // Time travel to specific message

  // Model control
  "model", // Per-run model override
  "fallbackModel", // Fallback if primary fails
  "temperature", // Sampling temperature
  "maxTokens", // Response length limit
  "maxThinkingTokens", // Reasoning depth limit
  "maxTurns", // Conversation turn limit
  "maxBudgetUsd", // Cost limit per run

  // Output control
  "outputFormat", // Structured output schema
  "includePartialMessages", // Streaming granularity

  // Optional features
  "enableFileCheckpointing", // File change tracking
  "strictMcpConfig", // MCP validation strictness
  "betas", // Beta feature flags
]);

/** Special tool name for state management */
export const STATE_MANAGEMENT_TOOL_NAME = "ag_ui_update_state";

/** Full prefixed name as it appears from Claude SDK */
export const STATE_MANAGEMENT_TOOL_FULL_NAME =
  "mcp__ag_ui__ag_ui_update_state";

/** MCP server name for dynamic AG-UI tools */
export const AG_UI_MCP_SERVER_NAME = "ag_ui";
