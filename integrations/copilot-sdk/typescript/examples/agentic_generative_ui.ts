import { setTimeout as sleep } from "node:timers/promises";
import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

type Step = { description: string; status: string };

/**
 * The steps stream into `state.steps` while the model writes them (PredictState);
 * the handler then "executes" them with committed STATE_SNAPSHOTs.
 */
export const createAgenticGenerativeUIAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "agentic_generative_ui",
    description: "Task runner that streams its progress into shared state",
    instructions: `You are a helpful assistant assisting with any task.
When asked to do something, you MUST call the function \`generate_task_steps\` that was provided to you.
If you called the function, you MUST NOT repeat the steps in your next response to the user.
Just give a very brief summary (one sentence) of what you did with some emojis.
Always say you actually did the steps, not merely generated them.`,
    predictState: [{ state_key: "steps", tool: "generate_task_steps", tool_argument: "steps" }],
    tools: [
      {
        name: "generate_task_steps",
        skipPermission: true,
        description:
          "Make up 10 steps (only a couple of words per step) that are required for a task. " +
          "The step should be in gerund form (i.e. Digging hole, opening door, ...)",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "An array of 10 step objects, each containing text and status",
              items: {
                type: "object",
                properties: {
                  description: { type: "string", description: "The text of the step in gerund form" },
                  status: { type: "string", enum: ["pending"], description: "Always 'pending'" },
                },
                required: ["description", "status"],
              },
            },
          },
          required: ["steps"],
        },
        handler: async (args: { steps: Step[] }, ctx) => {
          const steps = args.steps.map((step) => ({ ...step, status: "pending" }));
          ctx.setState({ steps });
          for (const step of steps) {
            await sleep(1000);
            step.status = "completed";
            ctx.setState({ steps });
          }
          return "Steps executed.";
        },
      },
    ],
  });
