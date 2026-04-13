"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface ErrorFlowProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const ErrorFlowPage: React.FC<ErrorFlowProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="error_flow"
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <CopilotChat
            agentId="error_flow"
            className="h-full rounded-2xl max-w-6xl mx-auto"
          />
        </div>
      </div>
    </CopilotKit>
  );
};

export default ErrorFlowPage;
