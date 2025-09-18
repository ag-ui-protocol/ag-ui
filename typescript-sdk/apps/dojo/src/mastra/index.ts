import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { DynamoDBStore } from "@mastra/dynamodb";

import { Mastra } from "@mastra/core";
import { createTool } from "@mastra/core";
import { z } from "zod";



function getStorage(): LibSQLStore | DynamoDBStore {
  if (process.env.DYNAMODB_TABLE_NAME) {
    return new DynamoDBStore({
    name: "dynamodb",
    config: {
      tableName: process.env.DYNAMODB_TABLE_NAME
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
        - If the location name isn't in English, please translate it
        - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
        - Include relevant details like humidity, wind conditions, and precipitation
        - Keep responses concise but informative

        Use the weatherTool to fetch current weather data.
  `,
      model: openai("gpt-4o"),
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
      tools: {
        weatherTool: createTool({
          id: "weatherTool",
          description: "Get current weather for a location",
          inputSchema: z.object({
            location: z.string().describe("The location to get weather for"),
          }),
          outputSchema: z.string(),
          execute: async ({ context }) => {
            const { location } = context;

            try {
              // Use OpenWeatherMap API or similar weather service
              // For now, we'll use a free weather API (Open-Meteo)
              const geocodeResponse = await fetch(
                `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
              );

              if (!geocodeResponse.ok) {
                throw new Error(`Geocoding failed: ${geocodeResponse.status}`);
              }

              const geocodeData = await geocodeResponse.json();

              if (!geocodeData.results || geocodeData.results.length === 0) {
                return `Sorry, I couldn't find weather data for "${location}". Please check the location name and try again.`;
              }

              const { latitude, longitude, name, country } = geocodeData.results[0];

              // Get weather data
              const weatherResponse = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`
              );

              if (!weatherResponse.ok) {
                throw new Error(`Weather API failed: ${weatherResponse.status}`);
              }

              const weatherData = await weatherResponse.json();

              if (!weatherData.current) {
                return `Sorry, I couldn't retrieve current weather data for "${location}". The weather service might be temporarily unavailable.`;
              }

              const current = weatherData.current;
              const temperature = current.temperature_2m;
              const humidity = current.relative_humidity_2m;
              const windSpeed = current.wind_speed_10m;
              const weatherCode = current.weather_code;

              // Simple weather code mapping
              const getWeatherCondition = (code: number): string => {
                if (code === 0) return "Clear sky";
                if (code <= 3) return "Partly cloudy";
                if (code <= 48) return "Foggy";
                if (code <= 67) return "Rainy";
                if (code <= 77) return "Snowy";
                if (code <= 82) return "Rainy";
                if (code <= 86) return "Snowy";
                return "Stormy";
              };

              const condition = getWeatherCondition(weatherCode);

              return `The current weather in ${name}, ${country} is as follows:
Temperature: ${temperature}°C
Humidity: ${humidity}%
Wind Speed: ${windSpeed} km/h
Conditions: ${condition}`;

            } catch (error) {
              console.error("Weather tool error:", error);
              return `I'm sorry, but I'm having trouble retrieving weather data for "${location}" at the moment. This could be due to a temporary service issue. Please try again later or check another weather source.`;
            }
          },
        }),
      },
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
