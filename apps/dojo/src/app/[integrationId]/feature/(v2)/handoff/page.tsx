"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat, useConfigureSuggestions } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface HandoffProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const Handoff: React.FC<HandoffProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="handoff"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Billing question",
        message: "I have a question about my last invoice",
      },
      {
        title: "Escalate an issue",
        message: "This isn't working and I've tried everything, I need to escalate this",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat agentId="handoff" className="h-full rounded-2xl max-w-6xl mx-auto" />
      </div>
    </div>
  );
};

export default Handoff;
