/**
 * Human-in-the-Loop example for AWS Strands (TypeScript).
 *
 * The `generate_task_steps` tool is declared on the frontend via
 * `useHumanInTheLoop`. The @ag-ui/aws-strands adapter auto-registers it as a
 * proxy tool when `RunAgentInput.tools` arrives, so the backend does not
 * register a native tool here — Strands invokes the proxy, the adapter halts
 * the run after the proxy returns, the user reviews and approves the plan in
 * the UI, and the tool result is fed back to the agent on the next turn.
 *
 * No backend tool stub. No agent-side AG-UI event emission.
 *
 * Mirrors the Python reference
 * (integrations/aws-strands/python/examples/server/api/human_in_the_loop.py).
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    tools: [],
    systemPrompt: `You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

**Your Primary Role:**
- Break down any user request into exactly 10 clear, actionable steps
- Generate steps that require human review and approval
- Execute only human-approved steps

**When a user requests help with a task:**
1. ALWAYS use the \`generate_task_steps\` tool to create a breakdown (default to 10 steps unless told otherwise)
2. Each step must be:
   - Brief (only a few words)
   - In imperative form (e.g., "Dig hole", "Open door", "Mix ingredients")
   - Clear and actionable
   - Logically ordered from start to finish
3. Set all steps to "enabled" status initially
4. After the user reviews the plan:
   - If accepted: Briefly confirm the plan (only include the approved steps) and proceed (don't repeat the steps). Do not ask for more clarifying information.
   - If rejected: Ask what they'd like to change (don't call generate_task_steps again until they provide input)
5. When the user accepts the plan, "execute" the plan by repeating the approved steps in order as if you have just done them. Then let the user know you have completed the plan.
    - example: if the user accepts the steps "Dig hole", "Open door", "Mix ingredients", you would respond with "Digging hole... Opening door... Mixing ingredients..."

**Important:**
- NEVER call \`generate_task_steps\` twice in a row without user input
- NEVER repeat the list of steps in your response after calling the tool
- DO provide a brief, creative summary of how you would execute the approved steps
`,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "human_in_the_loop",
    description: "AWS Strands agent with human-in-the-loop task planning",
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

void main();
