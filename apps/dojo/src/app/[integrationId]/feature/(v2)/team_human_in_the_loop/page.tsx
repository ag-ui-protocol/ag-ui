"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  useConfigureSuggestions,
  useHumanInTheLoop,
  CopilotChat,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { z } from "zod";
import { EmailConfirmationCard } from "../hitl-components";

interface TeamHumanInTheLoopProps {
  params: Promise<{ integrationId: string }>;
}

const TeamHumanInTheLoop: React.FC<TeamHumanInTheLoopProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="team_human_in_the_loop"
    >
      <CopilotChatConfigurationProvider agentId="team_human_in_the_loop">
        <ChatContent />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
};

const ChatContent = () => {
  useConfigureSuggestions({
    suggestions: [
      { title: "Send email", message: "Email alice@example.com to say the quarterly report is ready" },
      { title: "Research", message: "What is the capital of France?" },
    ],
    available: "always",
  });

  // Test: Register frontend tool with same name as backend tool
  // CopilotKit uses "last-in wins" - frontend tool takes priority over backend
  // When agent calls send_email, frontend intercepts it and shows HITL UI
  useHumanInTheLoop({
    agentId: "team_human_in_the_loop",
    name: "send_email",
    description: "Send an email (requires user confirmation)",
    parameters: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body content"),
    }),
    render: ({ args, respond, status }: any) => (
      <EmailConfirmationCard args={args} respond={respond} status={status} />
    ),
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="team_human_in_the_loop"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

export default TeamHumanInTheLoop;
