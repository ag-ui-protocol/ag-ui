/**
 * A simple agentic chat flow using Cloudflare Workers AI.
 *
 * This agent demonstrates basic chat functionality using the ReAct design pattern
 * with Cloudflare's Llama 3.1 8B model.
 *
 * Features:
 * - Streaming text responses
 * - Tool calling support (when tools are provided)
 * - Proper AG-UI protocol event emission
 */

import { CloudflareAgent, CLOUDFLARE_MODELS } from "@ag-ui/cloudflare";

/**
 * Agentic Chat Agent
 *
 * A helpful assistant powered by Cloudflare Workers AI that can engage in
 * natural conversation and use tools when provided.
 */
export class AgenticChatAgent extends CloudflareAgent {
  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      throw new Error(
        "Missing required environment variables: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
      );
    }

    super({
      accountId,
      apiToken,
      model: CLOUDFLARE_MODELS.LLAMA_3_1_8B,
      systemPrompt: `You are a helpful AI assistant. You provide clear, accurate, and friendly responses to user queries.

IMPORTANT: Only use the available tools when the user explicitly asks you to do something that requires them.
- For the change_background tool, ONLY use it when the user specifically asks to change the background, modify colors, or adjust the theme.
- DO NOT call tools for simple greetings, general questions, or casual conversation.
- When in doubt, just respond conversationally without using tools.`,
      streamingEnabled: true,
    });
  }
}

// Lazy singleton - created on first use after env vars are loaded
let _agenticChatAgent: AgenticChatAgent | null = null;

export function getAgenticChatAgent(): AgenticChatAgent {
  if (!_agenticChatAgent) {
    _agenticChatAgent = new AgenticChatAgent();
  }
  return _agenticChatAgent;
}
