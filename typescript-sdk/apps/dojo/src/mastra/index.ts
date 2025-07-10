import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { DynamoDBStore } from "@mastra/dynamodb";

import { Mastra } from "@mastra/core";
import { z } from "zod";


let storage: LibSQLStore | DynamoDBStore

if (process.env.DYNAMODB_TABLE_NAME) {
  storage = new DynamoDBStore({
  name: "dynamodb", 
  config: {
    tableName: process.env.DYNAMODB_TABLE_NAME
  },
});
} else {
  storage = new LibSQLStore({ url: "file::memory:" });
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
  
        Use the weatherTool to fetch current weather data.
  `,
      model: openai("gpt-4o"),
      memory: new Memory({
        storage: storage,
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

        If you have just created or modified the recipe, just answer in one sentence what you did. dont describe the recipe, just say what you did.
      `,
      model: openai("gpt-4o"),
      memory: new Memory({
        storage: storage,
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
  },
});
