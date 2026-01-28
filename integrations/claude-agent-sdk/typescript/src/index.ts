/**
 * AG-UI integration for Anthropic Claude Agent SDK.
 *
 * @example
 * ```typescript
 * import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
 * import type { Options } from "@anthropic-ai/claude-agent-sdk";
 *
 * const adapter = new ClaudeAgentAdapter({
 *   model: "claude-sonnet-4-20250514",
 *   permissionMode: "acceptEdits",
 * });
 * ```
 * 
 * For types, import directly from the SDK:
 * - `import type { Options, SDKSession } from "@anthropic-ai/claude-agent-sdk"`
 * - `import type { BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages"`
 */

export { ClaudeAgentAdapter } from "./adapter";
export type { ClaudeAgentAdapterConfig } from "./types";

