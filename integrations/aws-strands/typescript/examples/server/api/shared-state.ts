/**
 * Shared State example for AWS Strands (TypeScript) — a collaborative recipe
 * editor. Shows how `stateContextBuilder`, `stateFromArgs`, and
 * `stateFromResult` keep a shared object in sync between the server and the
 * UI while the agent is streaming.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent, type StrandsAgentConfig } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

const recipeSchema = z.object({
  title: z.string(),
  skill_level: z.string(),
  special_preferences: z.array(z.string()),
  cooking_time: z.string(),
  ingredients: z.array(
    z.object({ icon: z.string(), name: z.string(), amount: z.string() }),
  ),
  instructions: z.array(z.string()),
  changes: z.string().default(""),
});

const generateRecipe = tool({
  name: "generate_recipe",
  description:
    "Using the existing (if any) ingredients and instructions, proceed with the recipe to finish it.",
  inputSchema: z.object({ recipe: recipeSchema }),
  callback() {
    return "Recipe updated successfully";
  },
});

const initialRecipe = {
  title: "Make Your Recipe",
  skill_level: "Intermediate",
  special_preferences: [] as string[],
  cooking_time: "45 min",
  ingredients: [
    { icon: "🥕", name: "Carrots", amount: "3 large, grated" },
    { icon: "🌾", name: "All-Purpose Flour", amount: "2 cups" },
  ],
  instructions: ["Preheat oven to 350°F (175°C)"],
  changes: "",
};

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    systemPrompt: "You are a helpful recipe editor.",
    tools: [generateRecipe],
  });

  const config: StrandsAgentConfig = {
    stateContextBuilder: (input, prompt) => {
      const state = (input.state ?? {}) as Record<string, unknown>;
      const recipe = state.recipe ?? initialRecipe;
      return `Current recipe state:\n${JSON.stringify(recipe, null, 2)}\n\nUser request: ${prompt}\n\nPlease update the recipe by calling the registered tool.`;
    },
    toolBehaviors: {
      generate_recipe: {
        // Stream the LLM's incremental `recipe` arg JSON into `state.recipe`
        // so the UI fills in fields progressively. Without this, the FE has
        // nothing to render until contentBlockStop fires `stateFromArgs`,
        // and the recipe pops in as a single bulk update. Mirrors the
        // langgraph shared-state demo (predict_state with state_key=recipe).
        predictState: [
          {
            stateKey: "recipe",
            tool: "generate_recipe",
            toolArgument: "recipe",
          },
        ],
        stateFromArgs: async (ctx) => {
          const args = ctx.toolInput as { recipe?: unknown };
          return args?.recipe ? { recipe: args.recipe } : null;
        },
      },
    },
  };

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "shared_state",
    description: "Strands agent with shared recipe state",
    config,
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  app.listen(Number(process.env.PORT ?? 8000));
}

void main();
