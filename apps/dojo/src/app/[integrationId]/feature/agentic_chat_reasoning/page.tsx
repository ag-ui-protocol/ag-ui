"use client";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import {
  CopilotKit,
  useCoAgent,
  useCopilotAction,
  useCopilotChat,
  useFrontendTool,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
      // agent lock to the relevant agent
      agent="agentic_chat_reasoning"
    >
      <Chat />
    </CopilotKit>
  );
};

interface AgentState {
  model: string;
}

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");
  const { state: agentState, setState: setAgentState } = useCoAgent<AgentState>({
    name: "agentic_chat_reasoning",
    initialState: {
      model: "OpenAI",
    },
  });

  // Initialize model if not set
  const selectedModel = agentState?.model || "OpenAI";

  const handleModelChange = (model: string) => {
    setAgentState({ model });
  };

  useFrontendTool({
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.",
    parameters: [
      {
        name: "background",
        type: "string",
        description: "The background. Prefer gradients.",
      },
    ],
    handler: ({ background }) => {
      setBackground(background);
    },
  });

  return (
    <div className="flex flex-col h-full w-full" style={{ background }}>
      {/* Reasoning Model Dropdown */}
      <div className="h-[65px] border-b border-gray-200 dark:border-gray-700">
        <div className="h-full flex items-center justify-center">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Reasoning Model:
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-[140px] justify-between">
                  {selectedModel}
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[140px]">
                <DropdownMenuLabel>Select Model</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleModelChange("OpenAI")}>
                  OpenAI
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleModelChange("Anthropic")}>
                  Anthropic
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleModelChange("Gemini")}>
                  Gemini
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Chat Container */}
      <div className="flex-1 flex justify-center items-center p-4">
        <div className="w-8/10 h-full rounded-lg">
          <CopilotChat
            className="h-full rounded-2xl"
            labels={{ initial: "Hi, I'm an agent. Want to chat?" }}
          />
        </div>
      </div>
    </div>
  );
};

export default AgenticChat;
