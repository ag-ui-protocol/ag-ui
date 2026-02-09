"use client";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import {
  CopilotKit,
  useFrontendTool,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import "./globals.css";

const AgenticChat = () => {
  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      showDevConsole={false}
      // Agent ID matching the one defined in the API route
      agent="agentic_chat"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");

  // Example frontend tool that can be called by Claude Agent
  // NOTE: useFrontendTool must be called inside a component that's wrapped by CopilotKit
  useFrontendTool({
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
    handler: ({ background }) => {
      setBackground(background);
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  return (
    <div
      className="flex justify-center items-center h-full w-full"
      style={{ background }}
    >
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          className="h-full rounded-2xl max-w-6xl mx-auto"
          labels={{ initial: "Hi! I'm Claude Agent powered by Claude Agent SDK. How can I help you?" }}
          suggestions={[
            {
              title: "Change background",
              message: "Change the background to a beautiful gradient.",
            },
            {
              title: "Write a poem",
              message: "Write a short poem about AI assistants.",
            },
            {
              title: "Explain Claude",
              message: "Explain what Claude Agent SDK is and how it works.",
            },
          ]}
        />
      </div>
    </div>
  );
};

export default AgenticChat;

