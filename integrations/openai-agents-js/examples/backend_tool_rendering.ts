/**
 * Backend tool rendering example — a server-side tool rendered in the frontend.
 *
 * Unlike the frontend-tool examples (which halt for client-side execution),
 * this defines an SDK-native `tool()` with a real `execute` that runs on the
 * server. When the model calls it, the adapter streams the TOOL_CALL_* +
 * TOOL_CALL_RESULT lifecycle so the frontend can render the call and its
 * result.
 */

import { tool } from "@openai/agents";
import { z } from "zod";
import { OpenAIAgentsAdapter } from "@ag-ui/openai-agents-js";
import { baseConfig } from "./constants";

/**
 * A mock weather tool that runs on the server and returns sample data.
 *
 * Built with the OpenAI Agents JS SDK's `tool()` factory; the adapter passes
 * it through to the Agent via `config.tools` (server-side execution).
 */
export const getWeather = tool({
  name: "get_weather",
  description: "Get current weather for a location.",
  parameters: z.object({
    location: z.string().describe("City or location name"),
  }),
  execute: async (args) => {
    // Mock data — replace with a real lookup in production.
    return {
      location: args.location,
      temperature: 20,
      conditions: "sunny",
      humidity: 50,
      windSpeed: 10,
      feelsLike: 25,
    };
  },
});

/**
 * Create adapter for the backend-tool-rendering demo.
 *
 * Demonstrates:
 * - SDK-native backend tool (server-side `execute`)
 * - TOOL_CALL_* + TOOL_CALL_RESULT streamed so the frontend can render it
 */
export function createBackendToolAdapter(): OpenAIAgentsAdapter {
  return new OpenAIAgentsAdapter({
    agentId: "backend_tool_rendering",
    description: "Weather assistant with a backend tool",
    ...baseConfig,
    instructions:
      "You are a helpful weather assistant. When users ask about weather, use the get_weather tool.",
    tools: [getWeather],
  });
}
