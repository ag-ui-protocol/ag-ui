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
import { EmailConfirmationCard, ConfirmationCard } from "../hitl-components";

interface ToolConfirmationProps {
  params: Promise<{ integrationId: string }>;
}

const ToolConfirmation: React.FC<ToolConfirmationProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="tool_confirmation"
    >
      <CopilotChatConfigurationProvider agentId="tool_confirmation">
        <ChatContent />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
};

const ChatContent = () => {
  useConfigureSuggestions({
    suggestions: [
      { title: "Send email", message: "Send an email to alice@example.com saying hello" },
      { title: "Delete files", message: "Delete all temporary files from the project" },
    ],
    available: "always",
  });

  useHumanInTheLoop({
    agentId: "tool_confirmation",
    name: "send_email",
    description: "Send an email (requires user confirmation before sending)",
    parameters: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body content"),
    }),
    render: ({ args, respond, status }: any) => (
      <EmailConfirmationCard args={args} respond={respond} status={status} />
    ),
  });

  useHumanInTheLoop({
    agentId: "tool_confirmation",
    name: "delete_files",
    description: "Delete files (requires user confirmation before deletion)",
    parameters: z.object({
      action: z.string().describe("Description of the delete action"),
      description: z.string().describe("What files will be deleted"),
      details: z.record(z.string()).optional().describe("Additional details about the files"),
    }),
    render: ({ args, respond, status }: any) => (
      <ConfirmationCard args={args} respond={respond} status={status} />
    ),
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="tool_confirmation"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

export default ToolConfirmation;
