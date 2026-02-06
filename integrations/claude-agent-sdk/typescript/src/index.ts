/**
 * AG-UI integration for Anthropic Claude Agent SDK.
 *
 * @example
 * ```typescript
 * import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
 *
 * const adapter = new ClaudeAgentAdapter({
 *   agentId: "my_agent",
 *   description: "A helpful assistant",
 *   model: "claude-haiku-4-5",
 *   systemPrompt: "You are helpful",
 * });
 * ```
 *
 * For types, import directly from the SDK:
 * - `import type { Options } from "@anthropic-ai/claude-agent-sdk"`
 * - `import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages"`
 */

export { ClaudeAgentAdapter } from "./adapter";
export type { ClaudeAgentAdapterConfig, ProcessedEvent } from "./types";
export {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  AG_UI_MCP_SERVER_NAME,
} from "./config";
