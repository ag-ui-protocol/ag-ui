/**
 * Backend Tool Rendering Agent using Cloudflare Workers AI
 *
 * This agent demonstrates how the backend can generate and return
 * React components that the frontend will render.
 *
 * Example: Generating a weather widget with custom styling and data
 * that the frontend renders as a React component.
 *
 * Features:
 * - Backend-generated UI components
 * - TOOL_RESULT events with render prop
 * - Rich, interactive UI elements
 */

import { CloudflareAgent, CLOUDFLARE_MODELS } from "@ag-ui/cloudflare";

/**
 * Backend Tool Rendering Agent
 *
 * An assistant that can generate React components on the backend
 * for the frontend to render.
 */
export class BackendToolRenderingAgent extends CloudflareAgent {
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
      model: CLOUDFLARE_MODELS.LLAMA_3_3_70B_FP8, // Using function-calling capable model
      systemPrompt: `You are a helpful assistant with access to various tools.

When the user asks for information or actions that can be enhanced with rich UI:
- Use the available tools when appropriate
- The frontend will render custom components for tool results
- Be conversational and explain what you're doing

Available capabilities:
- show_weather: Display weather information in a rich UI card
- show_stock: Display stock prices with charts
- show_calendar: Display calendar events

IMPORTANT: Only use tools when the user explicitly asks for them or when they would enhance the response.
Do NOT call tools for simple greetings or general questions.`,
      streamingEnabled: true,
    });
  }
}

// Lazy singleton
let _backendToolRenderingAgent: BackendToolRenderingAgent | null = null;

export function getBackendToolRenderingAgent(): BackendToolRenderingAgent {
  if (!_backendToolRenderingAgent) {
    _backendToolRenderingAgent = new BackendToolRenderingAgent();
  }
  return _backendToolRenderingAgent;
}
