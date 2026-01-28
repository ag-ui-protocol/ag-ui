"use client";

import { ProverbsCard } from "@/components/proverbs";
import { WeatherCard } from "@/components/weather";
import { MoonCard } from "@/components/moon";
import { useAgent, CopilotSidebar, useConfigureSuggestions, useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { CopilotKitCSSProperties } from "@copilotkit/react-ui";
import { useState } from "react";
import { z } from "zod";

export default function CopilotKitPage() {
  const [themeColor, setThemeColor] = useState("#6366f1");

  // 🪁 Frontend Actions using v2 useFrontendTool
  useFrontendTool({
    name: "setThemeColor",
    description: "Set the theme color. Make sure to pick nice colors.",
    parameters: z.object({
      themeColor: z.string().describe("The theme color to set"),
    }),
    handler: async ({ themeColor }) => {
      setThemeColor(themeColor);
      return `Theme color set to ${themeColor}`;
    },
  }, []);

  // Configure suggestions for v2
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Generative UI",
        message: "Get the weather in San Francisco.",
      },
      {
        title: "Frontend Tools",
        message: "Set the theme to green.",
      },
      {
        title: "Human In the Loop",
        message: "Please go to the moon.",
      },
      {
        title: "Write Agent State",
        message: "Add a proverb about AI.",
      },
      {
        title: "Update Agent State",
        message: "Please remove 1 random proverb from the list if there are any.",
      },
      {
        title: "Read Agent State",
        message: "What are the proverbs?",
      },
    ],
  }, []);

  return (
    <main
      style={
        { "--copilot-kit-primary-color": themeColor } as CopilotKitCSSProperties
      }
      className="flex"
    >
      <YourMainContent themeColor={themeColor} />
      <CopilotSidebar defaultOpen={true} />
    </main>
  );
}

function YourMainContent({ themeColor }: { themeColor: string }) {
  // 🪁 Shared State: https://docs.copilotkit.ai/mastra/shared-state/in-app-agent-read
  const { agent } = useAgent({ agentId: 'weatherAgent' });
  const { state, setState } = agent;
    console.log('agent.messages', agent.messages);
    console.log('agent.messages json', JSON.stringify(agent.messages, null, 2));

  // 🪁 Generative UI using v2 useFrontendTool with render
  useFrontendTool(
    {
      name: "get-weather",
      description: "Get the weather for a given location.",
      parameters: z.object({
        location: z.string().describe("The location to get weather for"),
      }),
      handler: async ({ location }) => {
        return `Weather data for ${location}`;
      },
      render: ({ args }) => {
        return <WeatherCard location={args.location} themeColor={themeColor} />;
      },
    },
    [themeColor],
  );

  // 🪁 Human In the Loop using v2 useHumanInTheLoop
  useHumanInTheLoop(
    {
      name: "go_to_moon",
      description: "Go to the moon on request.",
      parameters: z.object({}),
      render: ({ status, respond }) => {
        return (
          <MoonCard themeColor={themeColor} status={status} respond={respond} />
        );
      },
    },
    [themeColor],
  );

  return (
    <div
      style={{ backgroundColor: themeColor }}
      className="h-screen flex-1 flex justify-center items-center flex-col transition-colors duration-300"
    >
      <ProverbsCard state={agent.state} setState={agent.setState} />
    </div>
  );
}
