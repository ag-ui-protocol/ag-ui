/**
 * Agentic Chat example for AWS Strands (TypeScript).
 *
 * Simple conversational agent. Frontend tools sent in RunAgentInput.tools
 * are automatically registered as proxy tools so no server-side @tool
 * definition is needed — the LLM calls them and the browser executes them.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    systemPrompt: `
    You are a helpful assistant.
    When the user greets you, always greet them back. Your greeting should always start with "Hello".
    Your greeting should also always ask (exact wording) "how can I assist you?"
  `,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "agentic_chat",
    description: "Conversational Strands agent with AG-UI streaming",
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Listening on http://localhost:${port}`);
  });
}

void main();
