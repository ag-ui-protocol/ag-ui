import type { CopilotClientPort } from "../dist/index.js";
import { defineAgent } from "./base.js";

/** A server-side tool; the Dojo renders its call and result as a weather card. */
export const createBackendToolRenderingAgent = (client: CopilotClientPort) =>
  defineAgent(client, {
    agentId: "backend_tool_rendering",
    description: "Weather assistant with a backend tool",
    instructions:
      "You are a helpful Weather Assistant. Always call the get_weather tool to " +
      "look up the weather before you answer.",
    tools: [
      {
        name: "get_weather",
        skipPermission: true,
        description: "Get current weather for a location",
        parameters: {
          type: "object",
          properties: { location: { type: "string", description: "City or location name" } },
          required: ["location"],
        },
        handler: () => ({
          temperature: 20,
          conditions: "sunny",
          humidity: 50,
          windSpeed: 10,
          feelsLike: 25,
        }),
      },
    ],
  });
