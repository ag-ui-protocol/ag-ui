"use client";

import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  CopilotKitProvider,
  useFrontendTool,
  ToolCallStatus,
} from "@copilotkit/react-core/v2";
import { createA2UIMessageRenderer } from "@copilotkit/a2ui-renderer";
import { theme } from "./theme";
import { z } from "zod";

export const dynamic = "force-dynamic";

const activityRenderers = [createA2UIMessageRenderer({ theme })];

interface PageProps {
  params: Promise<{
    integrationId: string;
  }>;
}

/**
 * Loading indicator shown while A2UI widget is being constructed
 */
function A2UILoadingIndicator({
  status,
}: {
  status: ToolCallStatus;
}) {
  if (status === ToolCallStatus.Complete) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-md text-gray-500 text-sm mb-3">
      <svg
        className="w-4 h-4 animate-spin"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span>Building interface...</span>
    </div>
  );
}

/**
 * Chat component that registers the A2UI loading indicator
 */
function Chat() {
  useFrontendTool(
    {
      name: "send_a2ui_json_to_client",
      description: "Sends A2UI JSON to the client to render rich UI",
      parameters: z.object({
        a2ui_json: z.string(),
      }),
      render: ({ status }) => <A2UILoadingIndicator status={status} />,
    },
    []
  );

  return <CopilotChat className="flex-1 overflow-hidden" agentId="a2ui_chat" />;
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkitnext/${integrationId}`}
      showDevConsole="auto"
      renderActivityMessages={activityRenderers}
    >
      <div className="a2ui-chat-container flex flex-col h-full overflow-hidden">
        <Chat />
      </div>
    </CopilotKitProvider>
  );
}
