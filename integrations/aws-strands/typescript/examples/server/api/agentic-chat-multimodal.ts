/**
 * Agentic Chat with Multimodal support for AWS Strands (TypeScript).
 *
 * Demonstrates multimodal message handling. When the user uploads an image,
 * the adapter converts AG-UI InputContent to Strands ContentBlock format
 * and passes it to the vision-capable model.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    systemPrompt: `
    You are a helpful assistant that can analyze images and documents.
    When the user shares an image, describe what you see in detail.
    When the user shares a document, summarize its contents.
    Always be descriptive and specific about visual content.
  `,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "agentic_chat_multimodal",
    description: "Conversational Strands agent with multimodal content support",
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

void main();
