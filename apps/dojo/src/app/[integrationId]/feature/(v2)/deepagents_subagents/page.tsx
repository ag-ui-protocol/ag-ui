"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  useAgent,
  UseAgentUpdate,
  useConfigureSuggestions,
  CopilotChat,
  CopilotChatConfigurationProvider,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import type { Message } from "@ag-ui/core";

const AGENT_ID = "deepagents_subagents";

interface DeepagentsSubagentsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

export default function DeepagentsSubagents({
  params,
}: DeepagentsSubagentsProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent={AGENT_ID}
    >
      <CopilotChatConfigurationProvider agentId={AGENT_ID}>
        <SubagentAttributionDemo />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
}

function SubagentAttributionDemo() {
  const { agent } = useAgent({
    agentId: AGENT_ID,
    updates: [UseAgentUpdate.OnMessagesChanged],
  });

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Run the subagents",
        message: "Research the topic of octopus intelligence using your subagents and summarize the findings.",
      },
    ],
    available: "always",
  });

  return (
    <div className="deepagents-subagents-container">
      <div className="deepagents-chat-panel">
        <CopilotChat agentId={AGENT_ID} className="h-full" />
      </div>
      <AttributionPanel messages={agent.messages} />
    </div>
  );
}

// subagentId is an AG-UI message field (see @ag-ui/core); it isn't part of the
// CopilotKit `Message` type yet, so it's read off the message via a cast.
function getSubagentId(message: Message): string | undefined {
  return (message as unknown as { subagentId?: string }).subagentId;
}

function AttributionPanel({ messages }: { messages: Message[] }) {
  return (
    <div className="subagent-attribution-panel" data-testid="subagent-attribution-panel">
      <div className="subagent-attribution-header">Message Attribution</div>
      <p className="subagent-attribution-hint">
        Each message below shows its role and, if the integration stamped a{" "}
        <code>subagentId</code>, a marker for the subagent that produced it.
      </p>
      <ul className="subagent-attribution-list">
        {messages.map((message, index) => {
          const subagentId = getSubagentId(message);
          return (
            <li
              key={message.id ?? index}
              className="subagent-attribution-item"
              data-testid="subagent-attribution-item"
            >
              <span className="subagent-role">{message.role}</span>
              {subagentId ? (
                <span className="subagent-marker" data-testid="subagent-marker">
                  ⟐ {subagentId}
                </span>
              ) : (
                <span className="subagent-marker subagent-marker--none">—</span>
              )}
            </li>
          );
        })}
        {messages.length === 0 && (
          <li className="subagent-attribution-empty">No messages yet — say hello!</li>
        )}
      </ul>
    </div>
  );
}
