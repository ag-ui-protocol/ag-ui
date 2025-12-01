import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import { weatherTool } from "../tools";
import { getStorage } from "../storage";

export const agenticChatAgent = new Agent({
  name: "agentic_chat",
  instructions: `
    You are a helpful weather assistant that provides accurate weather information.

    Your primary function is to help users get weather details for specific locations. When responding:
    - Always ask for a location if none is provided
    - If the location name isn't in English, please translate it
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
});
