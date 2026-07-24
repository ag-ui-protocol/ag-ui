"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import type { AssistantMessage } from "@ag-ui/core";

interface NestedTeamChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

function TeamAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const { message } = props;
  const name = (message as AssistantMessage & { name?: string }).name;

  return (
    <div className="cpk:flex cpk:flex-col cpk:gap-1">
      {name && (
        <div className="cpk:flex cpk:items-center cpk:gap-2 cpk:mb-1">
          <span className="cpk:inline-flex cpk:items-center cpk:px-2 cpk:py-0.5 cpk:rounded-full cpk:text-xs cpk:font-medium cpk:bg-blue-100 cpk:text-blue-800 dark:cpk:bg-blue-900 dark:cpk:text-blue-200">
            {name}
          </span>
        </div>
      )}
      <CopilotChatAssistantMessage {...props} />
    </div>
  );
}

// Type assertion to satisfy SlotValue — the component works at runtime
const TeamAssistantMessageSlot = TeamAssistantMessage as unknown as typeof CopilotChatAssistantMessage;

const NestedTeamChat: React.FC<NestedTeamChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="nested_team_chat"
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <CopilotChat
            agentId="nested_team_chat"
            className="h-full rounded-2xl max-w-6xl mx-auto"
            messageView={{
              assistantMessage: TeamAssistantMessageSlot,
            }}
          />
        </div>
      </div>
    </CopilotKit>
  );
};

export default NestedTeamChat;
