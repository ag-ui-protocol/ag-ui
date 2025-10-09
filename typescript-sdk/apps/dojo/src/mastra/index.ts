import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { DynamoDBStore } from "@mastra/dynamodb";

import { createStep, createWorkflow, Mastra } from "@mastra/core";
import { createTool } from "@mastra/core";
import { z } from "zod";
import { weatherTool } from "./tools";

function getStorage(): LibSQLStore | DynamoDBStore {
  if (process.env.DYNAMODB_TABLE_NAME) {
    return new DynamoDBStore({
      name: "dynamodb",
      config: {
        tableName: process.env.DYNAMODB_TABLE_NAME,
      },
    });
  } else {
    return new LibSQLStore({ url: "file::memory:" });
  }
}

export const mastra = new Mastra({
  agents: {
    agentic_chat: new Agent({
      name: "agentic_chat",
      instructions: `
        You are a helpful weather assistant that provides accurate weather information.

        Your primary function is to help users get weather details for specific locations. When responding:
        - Always ask for a location if none is provided
        - If the location name isn’t in English, please translate it
        - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
        - Include relevant details like humidity, wind conditions, and precipitation
        - Keep responses concise but informative
    `,
      model: openai("gpt-4o"),
      tools: { get_weather: weatherTool },
      memory: new Memory({
        storage: getStorage(),
        options: {
          workingMemory: {
            enabled: true,
            schema: z.object({
              firstName: z.string(),
            }),
          },
        },
      }),
    }),
    backend_tool_rendering: new Agent({
      name: "Weather Agent",
      instructions: `
          You are a helpful weather assistant that provides accurate weather information.

          Your primary function is to help users get weather details for specific locations. When responding:
          - Always ask for a location if none is provided
          - If the location name isn’t in English, please translate it
          - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
          - Include relevant details like humidity, wind conditions, and precipitation
          - Keep responses concise but informative

          Use the weatherTool to fetch current weather data.
    `,
      model: openai("gpt-4o-mini"),
      tools: { get_weather: weatherTool },
      memory: new Memory({
        storage: getStorage(),
      }),
    }),
    shared_state: new Agent({
      name: "shared_state",
      instructions: `
        You are a helpful assistant for creating recipes.

        IMPORTANT:
        1. Create a recipe using the existing ingredients and instructions. Make sure the recipe is complete.
        2. For ingredients, append new ingredients to the existing ones.
        3. For instructions, append new steps to the existing ones.
        4. 'ingredients' is always an array of objects with 'icon', 'name', and 'amount' fields
        5. 'instructions' is always an array of strings

        If you have just created or modified the recipe, just answer in one sentence what you did. dont describe the recipe, just say what you did. Do not mention "working memory", "memory", or "state" in your answer.
      `,
      model: openai("gpt-4o"),
      memory: new Memory({
        storage: getStorage(),
        options: {
          workingMemory: {
            enabled: true,
            schema: z.object({
              recipe: z.object({
                skill_level: z
                  .enum(["Beginner", "Intermediate", "Advanced"])
                  .describe("The skill level required for the recipe"),
                special_preferences: z
                  .array(
                    z.enum([
                      "High Protein",
                      "Low Carb",
                      "Spicy",
                      "Budget-Friendly",
                      "One-Pot Meal",
                      "Vegetarian",
                      "Vegan",
                    ]),
                  )
                  .describe("A list of special preferences for the recipe"),
                cooking_time: z
                  .enum(["5 min", "15 min", "30 min", "45 min", "60+ min"])
                  .describe("The cooking time of the recipe"),
                ingredients: z
                  .array(
                    z.object({
                      icon: z
                        .string()
                        .describe(
                          "The icon emoji (not emoji code like '\x1f35e', but the actual emoji like 🥕) of the ingredient",
                        ),
                      name: z.string().describe("The name of the ingredient"),
                      amount: z.string().describe("The amount of the ingredient"),
                    }),
                  )
                  .describe(
                    "Entire list of ingredients for the recipe, including the new ingredients and the ones that are already in the recipe",
                  ),
                instructions: z
                  .array(z.string())
                  .describe(
                    "Entire list of instructions for the recipe, including the new instructions and the ones that are already there",
                  ),
                changes: z.string().describe("A description of the changes made to the recipe"),
              }),
            }),
          },
        },
      }),
    }),
    tool_based_generative_ui: new Agent({
      name: "tool_based_generative_ui",
      instructions: `
        You are a helpful assistant for creating haikus.
      `,
      model: openai("gpt-4o"),
      tools: {
        generate_haiku: createTool({
          id: "generate_haiku",
          description:
            "Generate a haiku in Japanese and its English translation. Also select exactly 3 relevant images from the provided list based on the haiku's theme.",
          inputSchema: z.object({
            japanese: z
              .array(z.string())
              .describe("An array of three lines of the haiku in Japanese"),
            english: z
              .array(z.string())
              .describe("An array of three lines of the haiku in English"),
          }),
          outputSchema: z.string(),
          execute: async ({ context }) => {
            return "Haiku generated.";
          },
        }),
      },
    }),
  },
});
