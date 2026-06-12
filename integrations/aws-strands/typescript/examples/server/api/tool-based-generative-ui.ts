/**
 * Tool-based Generative UI example for AWS Strands (TypeScript).
 *
 * The `generate_haiku` tool is declared on the frontend via `useFrontendTool`
 * — the @ag-ui/aws-strands adapter auto-registers it as a proxy tool when
 * `RunAgentInput.tools` arrives, so the backend does not register a native
 * tool here. Strands invokes the proxy with the structured haiku args, the
 * adapter halts the run after the proxy returns, and the browser renders the
 * haiku card from the streamed `TOOL_CALL_*` events.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a creative haiku generator.

When the user asks for a haiku, ALWAYS call the \`generate_haiku\` tool with:
- 3 lines of haiku in Japanese
- 3 lines of haiku translated to English
- One relevant image_name from the provided list
- A CSS gradient for the card background

Do not respond with plain text — always use the tool.`,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "tool_based_generative_ui",
    description: "AWS Strands haiku generator with frontend-rendered tool",
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

void main();
