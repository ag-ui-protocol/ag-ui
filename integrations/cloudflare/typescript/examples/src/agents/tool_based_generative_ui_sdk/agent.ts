/**
 * Tool-Based Generative UI Agent (Cloudflare Agents SDK version)
 *
 * Alternative implementation using CloudflareAIClient directly instead of
 * extending CloudflareAgent. Demonstrates manual streaming and state management.
 *
 * @see tool_based_generative_ui/agent.ts for the standard CloudflareAgent approach
 */

import { CloudflareAIClient } from "@ag-ui/cloudflare";

export class ToolBasedGenerativeUiAgent {
  id = "tool-based-generative-ui-agent";
  private state: Record<string, any> = {};
  private client: CloudflareAIClient;

  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      throw new Error(
        "Missing required environment variables: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
      );
    }

    this.client = new CloudflareAIClient({
      accountId,
      apiToken,
      model: "@cf/meta/llama-3.1-8b-instruct",
    });
  }

  async setState(state: Record<string, any>): Promise<void> {
    this.state = { ...this.state, ...state };
  }

  getState(): Record<string, any> {
    return this.state;
  }

  async sql<T = any>(query: TemplateStringsArray, ...values: any[]): Promise<T[]> {
    // Not used for this agent
    return [];
  }

  async schedule(when: string | Date | number, callback: string, data?: any): Promise<void> {
    // Not used for this agent
  }

  /**
   * Handles chat messages and generates haikus using actual AI
   */
  async *onChatMessage(message: string, context: any): AsyncGenerator<any> {
    const systemPrompt = `You are an expert haiku composer. Create a traditional Japanese haiku (5-7-5 syllable structure).

Response format (JSON):
{
  "japanese": ["<5 syllable line>", "<7 syllable line>", "<5 syllable line>"],
  "english": ["<english line 1>", "<english line 2>", "<english line 3>"]
}`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: message },
    ];

    try {
      for await (const chunk of this.client.streamComplete({ messages, stream: true })) {
        if (chunk.response) {
          yield chunk.response;
        }
      }
    } catch (error) {
      console.error("Error generating haiku:", error);
      yield `Error generating haiku: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
  }

  async onRequest(request: Request): Promise<Response> {
    return new Response("Use AG-UI adapter", { status: 501 });
  }
}

/**
 * Singleton instance
 */
let _agent: ToolBasedGenerativeUiAgent | null = null;

export function getToolBasedGenerativeUiAgent(): ToolBasedGenerativeUiAgent {
  if (!_agent) {
    _agent = new ToolBasedGenerativeUiAgent();
  }
  return _agent;
}
