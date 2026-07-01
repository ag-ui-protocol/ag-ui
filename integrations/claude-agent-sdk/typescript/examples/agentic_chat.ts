/**
 * Agentic chat example - basic configuration.
 *
 * This example shows how to create a basic agentic chat adapter
 * using the Claude Agent SDK integration.
 */

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { DEFAULT_DISALLOWED_TOOLS } from "./constants";

/**
 * Create adapter for agentic chat.
 *
 * The adapter configuration supports all Claude SDK Options.
 * See: https://platform.claude.com/docs/en/agent-sdk/typescript
 */
export function createAgenticChatAdapter(): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({
    agentId: "agentic_chat",
    description: "General purpose agentic chat assistant",
    model: "claude-haiku-4-5",
    systemPrompt: "You are a helpful assistant with access to tools.",
    includePartialMessages: true,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
  });
}
