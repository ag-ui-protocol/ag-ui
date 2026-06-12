/**
 * Agentic Chat with Reasoning example for AWS Strands (TypeScript).
 *
 * Demonstrates reasoning/thinking event streaming. When the underlying model
 * supports extended thinking, the adapter emits REASONING_* events that the
 * frontend can display as a "thinking" indicator.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel({ reasoning: true }),
    systemPrompt: `
    You are a helpful assistant that thinks through problems step by step.
    When the user greets you, always greet them back. Your greeting should always start with "Hello".
    Your greeting should also always ask (exact wording) "how can I assist you?"
    When reasoning about a problem, break it down into clear steps before answering.
  `,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "agentic_chat_reasoning",
    description:
      "Conversational Strands agent with reasoning/thinking event streaming",
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

void main();
