"use client";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import { CopilotChat } from "@copilotkit/react-ui";
import { CopilotKit, useCopilotAction } from "@copilotkit/react-core";
import { z } from "zod";

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

  useCopilotAction({
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear or radial gradients etc.",
    parameters: [
      {
        name: "background",
        type: "string",
        description: "The background. Prefer gradients. Only use when asked.",
      },
    ],
    handler: async ({ background }: { background: string }) => {
      setBackground(background);
      return "Background changed successfully";
    },
  });

  return (
    <div
      className="flex justify-center items-center h-full w-full"
      data-testid="background-container"
      style={{ background }}
    >
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          className="h-full rounded-2xl max-w-6xl mx-auto"
          attachments={{ enabled: true }}
          instructions="You are a helpful assistant that can analyze images, documents, and other media. When a user shares an image, describe what you see in detail."
        />
      </div>
    </div>
  );
};

export default AgenticChatMultimodal;
