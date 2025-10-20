/**
 * Human-in-the-Loop Agent using Cloudflare Workers AI
 *
 * This agent demonstrates how to pause execution and request user input
 * before proceeding with a task.
 *
 * Example: When generating a task plan, the agent can ask the user to
 * review and approve/modify the steps before execution.
 *
 * Features:
 * - Tool calling for user confirmation requests
 * - Interactive step selection
 * - User feedback integration
 */

import { CloudflareAgent, CLOUDFLARE_MODELS } from "@ag-ui/cloudflare";

/**
 * Human-in-the-Loop Agent
 *
 * An assistant that requests user confirmation for generated task steps
 * before proceeding with execution.
 */
export class HumanInTheLoopAgent extends CloudflareAgent {
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
      model: CLOUDFLARE_MODELS.HERMES_2_PRO_7B,
      systemPrompt: `You are a helpful assistant that creates collaborative task plans. When asked to help with a task, use the generate_task_steps tool to present 5-10 clear, actionable steps for user review.`,
      streamingEnabled: true,
    });
  }
}

// Lazy singleton
let _humanInTheLoopAgent: HumanInTheLoopAgent | null = null;

export function getHumanInTheLoopAgent(): HumanInTheLoopAgent {
  if (!_humanInTheLoopAgent) {
    _humanInTheLoopAgent = new HumanInTheLoopAgent();
  }
  return _humanInTheLoopAgent;
}
