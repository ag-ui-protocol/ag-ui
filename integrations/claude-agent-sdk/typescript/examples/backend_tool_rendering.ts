/**
 * Backend tool rendering example.
 *
 * This example demonstrates how to create an agent with backend-defined MCP tools.
 * The tools are rendered in the AG-UI frontend when the agent uses them.
 */

import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";
import { DEFAULT_DISALLOWED_TOOLS } from "./constants";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Mock weather tool that returns sample weather data.
 *
 * Uses the Claude Agent SDK's tool() function with Zod schema.
 * See: https://platform.claude.com/docs/en/agent-sdk/typescript#tool
 */
const getWeather = tool(
  "get_weather",
  "Get current weather for a location",
  {
    location: z.string().describe("City or location name"),
  },
  async (args) => {
    const weatherData = {
      temperature: 20,
      conditions: "sunny",
      humidity: 50,
      windSpeed: 10,
      feelsLike: 25,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(weatherData) }],
    };
  }
);

// Create MCP server with weather tool
const weatherServer = createSdkMcpServer({
  name: "weather",
  version: "1.0.0",
  tools: [getWeather],
});

/**
 * Create adapter for backend tool rendering demo.
 *
 * This shows how to configure an agent with custom MCP tools
 * that will be displayed in the AG-UI frontend.
 */
export function createBackendToolAdapter(): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({
    agentId: "backend_tool_rendering",
    description: "Weather assistant with backend MCP tools",
    model: "claude-haiku-4-5",
    systemPrompt:
      "You are a helpful weather assistant. When users ask about weather, use the get_weather tool.",
    mcpServers: { weather: weatherServer },
    allowedTools: ["mcp__weather__get_weather"],
    includePartialMessages: true,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
  });
}
