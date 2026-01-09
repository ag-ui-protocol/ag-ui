/**
 * Agentic chat example - basic configuration.
 *
 * This example shows how to create a basic agentic chat adapter
 * using the Claude Agent SDK integration.
 */

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";

/**
 * Create adapter for agentic chat.
 *
 * The adapter configuration supports all ClaudeAgentOptions from the Claude Agent SDK.
 * See: https://platform.claude.com/docs/en/agent-sdk/typescript
 */
export function createAgenticChatAdapter(): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({
    model: "claude-haiku-4-5",
    systemPrompt: "You are a helpful assistant with access to tools.",
    includePartialMessages: true,
  });
}
