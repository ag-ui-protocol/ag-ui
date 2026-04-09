import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { weatherTool } from "../tools/weather-tool";

export const agenticChatReasoningAgent = new Agent({
  id: "agentic_chat_reasoning",
  name: "Agentic Chat Reasoning",
  instructions: {
    role: "system",
    content: `
      You are a helpful assistant with reasoning capabilities.

      You have access to a weather tool. When responding:
      - Always ask for a location if none is provided
      - If the location name isn't in English, please translate it
      - Include relevant details like humidity, wind conditions, and precipitation
      - Keep responses concise but informative
      - Think step by step when answering complex questions

      Use the get_weather tool to fetch current weather data.
    `,
    providerOptions: {
      openai: { reasoningEffort: "high" },
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 2000 },
      },
    },
  },
  model: "openai/o3",
  tools: { get_weather: weatherTool },
  memory: new Memory({
    storage: new LibSQLStore({
      id: "agentic-chat-reasoning-memory",
      url: "file:../mastra.db",
    }),
  }),
});
