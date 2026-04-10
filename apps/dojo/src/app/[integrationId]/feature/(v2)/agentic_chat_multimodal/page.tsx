"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  useFrontendTool,
  useConfigureSuggestions,
  CopilotChat,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import { CopilotKit } from "@copilotkit/react-core";

interface AgenticChatMultimodalProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const AgenticChatMultimodal: React.FC<AgenticChatMultimodalProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="agentic_chat_multimodal"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");

  useFrontendTool({
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear or radial gradients etc.",
    parameters: z.object({
      background: z.string().describe("The background. Prefer gradients. Only use when asked."),
    }),
    handler: async ({ background }: { background: string }) => {
      setBackground(background);
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Upload an image",
        message: "Describe what you see in the image I upload.",
      },
      {
        title: "Analyze a photo",
        message: "What objects can you identify in this photo?",
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
          agentId="agentic_chat_multimodal"
          className="h-full rounded-2xl max-w-6xl mx-auto"
          attachments={{ enabled: true }}
        />
      </div>
    </div>
  );
};

export default AgenticChatMultimodal;
