/**
 * Agentic chat example — basic configuration.
 *
 * The simplest possible OpenAI Agents JS agent behind AG-UI: an assistant
 * that streams text responses. No tools, no shared state.
 */

import { OpenAIAgentsAdapter } from "../src";
import { baseConfig } from "./constants";

/**
 * Create adapter for agentic chat.
 *
 * The adapter manages the OpenAI Agents JS SDK lifecycle internally — just
 * call `adapter.run(input)` and subscribe to the AG-UI event stream.
 */
export function createAgenticChatAdapter(): OpenAIAgentsAdapter {
  return new OpenAIAgentsAdapter({
    agentId: "agentic_chat",
    description: "General purpose agentic chat assistant",
    ...baseConfig,
    instructions: "You are a helpful assistant.",
  });
}
