"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import { 
  useFrontendTool,
  useRenderTool,
  useAgentContext,
  useConfigureSuggestions,
  CopilotChat,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import { CopilotKit } from "@copilotkit/react-core";

interface AgenticChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const AgenticChat: React.FC<AgenticChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");

  useAgentContext({
    description: 'Name of the user',
    value: 'Bob'
  });

  useFrontendTool({
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.",
    parameters: z.object({
      background: z.string().describe("The background. Prefer gradients. Only use when asked."),
    }) ,
    handler: async ({ background }: { background: string }) => {
      setBackground(background);
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  useRenderTool({
    name: "get_weather",
    parameters: z.object({
      location: z.string(),
    })  ,
    render: ({ args, result, status }: any) => {
      if (status !== "complete") {
        return <div data-testid="weather-info-loading">Loading weather...</div>;
      }
      return (
        <div data-testid="weather-info">
          <strong>Weather in {result?.city || args.location}</strong>
          <div>Temperature: {result?.temperature}°C</div>
          <div>Humidity: {result?.humidity}%</div>
          <div>Wind Speed: {result?.windSpeed ?? result?.wind_speed} mph</div>
          <div>Conditions: {result?.conditions}</div>
        </div>
      );
    },
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Change background",
        message: "Change the background to something new.",
      },
      {
        title: "Generate sonnet",
        message: "Write a short sonnet about AI.",
      },
    ],
    available: "always",
  });

  return (
    <div
      className="flex justify-center items-center h-full w-full"
      data-testid="background-container"
      style={{ background }}
    >
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="agentic_chat"
          className="h-full rounded-2xl max-w-6xl mx-auto"
          labels={{ welcomeMessageText: "Hi, I'm an agent. Want to chat?" }}
        />
      </div>
    </div>
  );
};

export default AgenticChat;
