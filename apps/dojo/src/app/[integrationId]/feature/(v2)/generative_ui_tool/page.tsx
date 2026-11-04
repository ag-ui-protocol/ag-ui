"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { standardUI } from "@copilotkit/react-core/v2/generative-ui";

const AGENT_ID = "generative_ui_tool";

interface GenerativeUIToolProps {
  params: Promise<{ integrationId: string }>;
}

/**
 * Generative UI (Tool). The runtime gives the agent a render_ui tool, and the agent streams A2UI 1.0 operations through it.
 * The chat renders them as live components from the standard catalog.
 * CopilotKit sends the instructions and the component schema as context, so
 * any agent that puts context into its prompt can do this with no agent code.
 */
const GenerativeUITool: React.FC<GenerativeUIToolProps> = ({ params }) => {
  const { integrationId } = React.use(params);
  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      generativeUI={{ ui: standardUI, transport: "tool" }}
    >
      <CopilotChatConfigurationProvider agentId={AGENT_ID}>
        <Chat />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
};

const Chat = () => {
  useConfigureSuggestions({
    suggestions: [
      { title: "Plan picker", message: "Show me a team plan picker with a seat slider and the monthly total." },
      { title: "Budget chart", message: "Chart my monthly budget: rent 1200, food 450, transport 120, savings 500." },
      { title: "Sign-up form", message: "Make a sign-up form with name and email, and check the email." },
    ],
    available: "always",
  });
  return (
    <div className="flex h-full w-full justify-center">
      <div className="h-full w-full max-w-4xl">
        <CopilotChat agentId={AGENT_ID} className="h-full rounded-2xl" />
      </div>
    </div>
  );
};

export default GenerativeUITool;
