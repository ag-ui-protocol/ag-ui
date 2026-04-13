"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface CrewChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const CrewChat: React.FC<CrewChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="crew_chat"
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <CopilotChat
            agentId="crew_chat"
            className="h-full rounded-2xl max-w-6xl mx-auto"
          />
        </div>
      </div>
    </CopilotKit>
  );
};

export default CrewChat;
