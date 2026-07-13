"use client";

import React from "react";
import { CopilotKit } from "@copilotkit/react-core";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";

interface AGUIDocsCopilotProps {
  params: Promise<{ integrationId: string }>;
}

const AGUIDocsCopilot: React.FC<AGUIDocsCopilotProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="ag_ui_docs_copilot"
    >
      <DocsChat />
    </CopilotKit>
  );
};

const DocsChat = () => {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Stream an existing agent",
        message:
          "Show me how to transfer an existing OpenAI Agents SDK streaming run to AG-UI. Give the smallest FastAPI endpoint using AGUITranslator.to_sdk(), Runner.run_streamed(), AGUITranslator.to_agui(), EventEncoder, and StreamingResponse. Explain only the data flow at each boundary.",
      },
      {
        title: "Map SDK events to AG-UI",
        message:
          "Give me one concise table that maps OpenAI Agents SDK streaming events and items to AG-UI events. Include run lifecycle, text messages, tool calls and results, reasoning, state snapshots, messages snapshots, and errors. Include only mappings supported by this integration.",
      },
      {
        title: "Choose an integration layer",
        message:
          "Compare the three integration APIs: AGUITranslator, OpenAIAgentsAgent, and add_openai_agents_fastapi_endpoint. Give one concise table with what each does, when to choose it, and how much control it keeps over the SDK agent and server.",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-full w-full rounded-lg md:h-8/10 md:w-8/10">
        <CopilotChat
          agentId="ag_ui_docs_copilot"
          className="mx-auto h-full max-w-5xl rounded-2xl"
        />
      </div>
    </div>
  );
};

export default AGUIDocsCopilot;
