/**
 * Backend Tool Rendering example for AWS Strands (TypeScript).
 *
 * Demonstrates backend-executed tools. Tool results flow through the
 * adapter as `TOOL_CALL_RESULT` events that the frontend can render
 * directly (e.g. charts, weather cards) without extra plumbing.
 */

import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";
import { createModel } from "../model-factory";

const getWeather = tool({
  name: "get_weather",
  description: "Gets the current weather for a given city.",
  inputSchema: z.object({
    city: z.string().describe("The city to fetch weather for."),
  }),
  callback({ city }) {
    return {
      city,
      temperatureC: 21,
      conditions: "Sunny",
    };
  },
});

const renderChart = tool({
  name: "render_chart",
  description: "Renders a chart for the given data series.",
  inputSchema: z.object({
    title: z.string(),
    points: z.array(z.object({ x: z.number(), y: z.number() })),
  }),
  callback(input) {
    return { rendered: true, ...input };
  },
});

async function main(): Promise<void> {
  const strandsAgent = new Agent({
    model: await createModel(),
    systemPrompt:
      "You are a helpful assistant. Use the tools to answer user questions, then narrate the result.",
    tools: [getWeather, renderChart],
  });

  const aguiAgent = new StrandsAgent({
    agent: strandsAgent,
    name: "backend_tool_rendering",
    description:
      "Strands agent that invokes backend tools and renders the results in the UI",
  });

  const app = await createStrandsApp(aguiAgent, { path: "/" });
  app.listen(Number(process.env.PORT ?? 8000));
}

void main();
