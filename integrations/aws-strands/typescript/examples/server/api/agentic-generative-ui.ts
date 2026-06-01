/**
 * Agentic Generative UI example for AWS Strands (TypeScript).
 *
 * Demonstrates streaming agent state updates to the frontend for real-time
 * UI rendering. Uses ONLY the canonical Strands + @ag-ui/aws-strands surface:
 *
 * - `predictState` mapping streams the predicted `steps` to the FE while
 *   the LLM is still emitting `plan_task_steps` arguments.
 * - The tool itself is an async generator. Each `yield` of `{ state: {...} }`
 *   becomes a Strands `ToolStreamEvent` which the @ag-ui/aws-strands adapter
 *   translates into an AG-UI `StateSnapshotEvent`.
 * - The FINAL value returned by the generator is the tool's result.
 *
 * The agent never emits AG-UI events directly. State updates flow through
 * Strands' native streaming mechanism, mirroring the Python reference
 * (integrations/aws-strands/python/examples/server/api/agentic_generative_ui.py).
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

const stepSchema = z.object({
  description: z
    .string()
    .describe("Gerund phrase describing the action, e.g. 'Sketching layout'"),
  status: z
    .string()
    .default("pending")
    .describe("Must be 'pending' when proposed"),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `plan_task_steps` as an async-generator tool. Each yielded `{ state: {...} }`
 * becomes a Strands `ToolStreamEvent` that the adapter translates into an
 * AG-UI `StateSnapshotEvent`. The final return value is the tool result.
 */
const planTaskSteps = tool({
  name: "plan_task_steps",
  description:
    "Plan the concrete steps required to accomplish a task and walk each step from 'pending' through 'in_progress' to 'completed' so the UI sees progress in real time.",
  inputSchema: z.object({
    task: z
      .string()
      .describe("Brief description of what the user wants to achieve"),
    context: z
      .string()
      .default("")
      .describe("Optional additional instructions"),
    steps: z
      .array(stepSchema)
      .describe("Ordered list of pending steps in gerund form"),
  }),
  callback: async function* ({ task, context, steps }) {
    const normalized = (steps ?? []).map(
      (s: { description: string; status?: string }) => ({
        description: s.description,
        status: s.status || "pending",
      }),
    );
    const workingSteps =
      normalized.length > 0
        ? normalized
        : fallbackSteps(task || "the task", context);
    const mutable = workingSteps.map((s) => ({ ...s }));

    // Re-confirm the canonical shape now that the tool body owns the state
    // (predictState will already have streamed something similar from args).
    yield { state: { steps: mutable.map((s) => ({ ...s })) } };

    for (let i = 0; i < mutable.length; i++) {
      await sleep(300 + Math.random() * 500);
      mutable[i]!.status = "in_progress";
      yield { state: { steps: mutable.map((s) => ({ ...s })) } };

      await sleep(400 + Math.random() * 600);
      mutable[i]!.status = "completed";
      yield { state: { steps: mutable.map((s) => ({ ...s })) } };
    }

    return { task, context, steps: mutable };
  },
});

function fallbackSteps(
  task: string,
  context: string,
): { description: string; status: string }[] {
  let count = 6;
  for (const token of (context ?? "").split(/\s+/)) {
    if (/^\d+$/.test(token)) {
      count = Math.max(4, Math.min(10, parseInt(token, 10)));
      break;
    }
  }
  const templates = [
    "Clarifying goals for {task}",
    "Gathering resources for {task}",
    "Preparing workspace for {task}",
    "Executing core work on {task}",
    "Reviewing results for {task}",
    "Wrapping up {task}",
    "Documenting learnings from {task}",
    "Celebrating completion of {task}",
  ];
  const plan: { description: string; status: string }[] = [];
  for (let i = 0; i < count; i++) {
    const raw = templates[i % templates.length]!.replace("{task}", task).trim();
    const description = raw.charAt(0).toUpperCase() + raw.slice(1);
    plan.push({ description, status: "pending" });
  }
  return plan;
}

async function main() {
  const config: StrandsAgentConfig = {
    stateContextBuilder: (input, prompt) => {
      const state = (input.state ?? {}) as Record<string, unknown>;
      const steps = state.steps;
      if (steps) {
        return (
          "A plan is already in progress. NEVER call plan_task_steps again unless the user explicitly " +
          "asks to restart. Discuss progress or ask clarifying questions instead.\n\n" +
          `Current steps:\n${JSON.stringify(steps, null, 2)}\n\nUser: ${prompt}`
        );
      }
      return prompt;
    },
    toolBehaviors: {
      plan_task_steps: {
        predictState: [
          { stateKey: "steps", tool: "plan_task_steps", toolArgument: "steps" },
        ],
        stateFromResult: async (ctx) => {
          const result = (ctx.resultData ?? {}) as { steps?: unknown[] };
          return result.steps ? { steps: result.steps } : null;
        },
      },
    },
  };

  const strandsAgent = new Agent({
    model: await createModel(),
    tools: [planTaskSteps],
    systemPrompt: `You are an energetic project assistant who decomposes user goals into action plans.

Planning rules:
1. When the user asks for help with a task or making a plan, call plan_task_steps exactly once.
2. Do NOT call plan_task_steps again unless the user explicitly says to restart.
3. Generate 4-6 concise steps in gerund form (e.g., "Setting up repo", "Testing prototype") with status "pending".
4. After the tool call, send a short confirmation (<= 2 sentences) plus one emoji.
5. If the user is just chatting, respond conversationally without calling the tool.
6. If a plan already exists, reference the current steps instead of creating a new plan.
`,
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "agentic_generative_ui",
    description: "AWS Strands agent with generative UI and state streaming",
    config,
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  const port = Number(process.env.PORT ?? 8000);
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

void main();
