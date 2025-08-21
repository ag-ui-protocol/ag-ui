"use client";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import { CopilotKit, useCoAgent, useCopilotAction, useCoAgentStateRender } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";

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
      agent="agentic_chat"
    >
      <Chat />
    </CopilotKit>
  );
};

interface CurrentThoughtsState {
  current_thoughts: { thought_text: string }[];
}

const ThinkingDisplay: React.FC<{ state: CurrentThoughtsState }> = ({ state }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  if (!state.current_thoughts?.length) return null;
  
  return (
    <div className="my-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-slate-600 hover:text-slate-800 animate-pulse"
      >
        <span>Thinking</span>
        <svg
          className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      
      {isExpanded && (
        <div className="px-4">
          <div className="text-xs text-slate-500 py-1 px-4 border-l gap-1.5 max-w-md mt-2 flex flex-col">
            {state.current_thoughts?.map((t, idx) => (
              <div key={idx} className={idx === state.current_thoughts.length - 1 ? 'animate-pulse' : ''}>
                {t.thought_text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");

  useCopilotAction({
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
      return {
        status: "success",
        message: `Background changed to ${background}`,
      };
    },
  });

  useCoAgentStateRender({
    name: "agentic_chat",
    render: ({ state }: { state: CurrentThoughtsState }) => {
      console.log(state)
      return <ThinkingDisplay state={state} />;
    },
  });

  return (
    <div className="flex justify-center items-center h-full w-full" style={{ background }}>
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          className="h-full rounded-2xl"
          labels={{ initial: "Hi, I'm an agent. Want to chat?" }}
        />
      </div>
    </div>
  );
};

export default AgenticChat;
