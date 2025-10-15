/**
 * Tool-based Generative UI Agent using Cloudflare Workers AI
 *
 * This agent demonstrates how frontend-provided tools (via CopilotKit actions)
 * can be used to render custom React components in the UI.
 *
 * Example: A haiku generation tool that the frontend can render as a custom
 * component with special styling or animations.
 *
 * Features:
 * - Tool calling support for frontend-defined actions
 * - Streaming tool call arguments
 * - AG-UI protocol TOOL_CALL_* events
 */

import { CloudflareAgent, CLOUDFLARE_MODELS } from "@ag-ui/cloudflare";

/**
 * Tool-Based Generative UI Agent
 *
 * Helps users with writing haikus. When tools are provided by the frontend
 * (e.g., generate_haiku), the agent will use them and the frontend can
 * render custom UI components for the tool results.
 */
export class ToolBasedGenerativeUiAgent extends CloudflareAgent {
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
      model: CLOUDFLARE_MODELS.LLAMA_3_3_70B, // Using 70B for better tool calling
      systemPrompt: "Help the user with writing Haikus. If the user asks for a haiku, use the generate_haiku tool to display the haiku to the user.",
      streamingEnabled: true,
    });
  }
}

// Lazy singleton
let _toolBasedAgent: ToolBasedGenerativeUiAgent | null = null;

export function getToolBasedGenerativeUiAgent(): ToolBasedGenerativeUiAgent {
  if (!_toolBasedAgent) {
    _toolBasedAgent = new ToolBasedGenerativeUiAgent();
  }
  return _toolBasedAgent;
}
