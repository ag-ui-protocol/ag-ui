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
      systemPrompt: `You are a helpful assistant that creates task plans.

When the user asks you to do something:
1. Break it down into 5-10 clear, actionable steps
2. Use the generate_task_steps tool to present the steps to the user for approval
3. Each step should have a description and status (enabled/disabled)
4. Wait for the user to review and confirm before proceeding

IMPORTANT: Only use the generate_task_steps tool when you have a complete plan ready.
Do NOT call the tool for simple greetings or questions.`,
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
