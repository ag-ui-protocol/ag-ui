/**
 * AG-UI integration for Anthropic Claude Agent SDK.
 *
 * The adapter manages the SDK query lifecycle internally — just call
 * `adapter.run(input)` and subscribe to the resulting AG-UI events.
 *
 * @example
 * ```typescript
 * import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
 *
 * const adapter = new ClaudeAgentAdapter({ model: "claude-haiku-4-5" });
 * const events$ = adapter.run(input);
 * ```
 */

export { ClaudeAgentAdapter } from "./adapter";
export type { ClaudeAgentAdapterConfig, ProcessedEvent } from "./types";
export {
  ALLOWED_FORWARDED_PROPS,
  STATE_MANAGEMENT_TOOL_NAME,
  AG_UI_MCP_SERVER_NAME,
} from "./config";
export { extractToolNames } from "./utils";
