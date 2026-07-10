"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  useHumanInTheLoop,
  useConfigureSuggestions,
  CopilotChat,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { z } from "zod";
import { MultipleChoiceCard } from "../hitl-components";

interface BackendFeedbackProps {
  params: Promise<{ integrationId: string }>;
}

const BackendFeedback: React.FC<BackendFeedbackProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="backend_feedback"
    >
      <CopilotChatConfigurationProvider agentId="backend_feedback">
        <ChatContent />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
};

const ChatContent = () => {
  useConfigureSuggestions({
    suggestions: [
      { title: "Restaurant", message: "Help me pick a cuisine for dinner" },
      { title: "Weekend", message: "Help me plan my weekend activities" },
    ],
    available: "always",
  });

  useHumanInTheLoop({
    agentId: "backend_feedback",
    name: "get_user_choice",
    description: "Present options to the user and get their selection",
    parameters: z.object({
      question: z.string().describe("The question to ask the user"),
      options: z.array(z.string()).describe("Array of options for the user to choose from"),
    }),
    render: ({ args, respond, status }: any) => (
      <MultipleChoiceCard args={args} respond={respond} status={status} />
    ),
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="backend_feedback"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

export default BackendFeedback;
