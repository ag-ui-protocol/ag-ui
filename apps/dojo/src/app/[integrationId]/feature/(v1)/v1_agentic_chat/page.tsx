"use client";
import React from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";

interface V1AgenticChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const V1AgenticChat: React.FC<V1AgenticChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="agentic_chat"
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <CopilotChat
            labels={{
              initial: "Hi, I'm a v1 agent. Want to chat?",
              placeholder: "Type a message...",
            }}
          />
        </div>
      </div>
    </CopilotKit>
  );
};

export default V1AgenticChat;
