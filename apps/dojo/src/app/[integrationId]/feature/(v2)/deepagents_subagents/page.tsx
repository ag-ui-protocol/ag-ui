"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  useConfigureSuggestions,
  CopilotChat,
  CopilotChatConfigurationProvider,
  CopilotChatAssistantMessage,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";

const AGENT_ID = "deepagents_subagents";

interface DeepagentsSubagentsProps {
  params: Promise<{
    integrationId: string;
  }>;
}

// `subagentId` is an AG-UI message field (see @ag-ui/core) stamped by the
// integration on messages a subagent produced. It isn't part of the CopilotKit
// AssistantMessage type surface yet, so read it off the message via a cast.
function getSubagentId(message: unknown): string | undefined {
  return (message as { subagentId?: string } | null | undefined)?.subagentId;
}

// Small inline pill identifying the subagent that produced a message. The tag
// sits at the top of the assistant bubble, so it labels both the message's text
// content and any tool-call cards rendered inside it.
function SubagentTag({ subagentId }: { subagentId: string }) {
  return (
    <span
      className="subagent-tag"
      data-testid="subagent-tag"
      title={`Produced by subagent ${subagentId}`}
    >
      <span className="subagent-tag-glyph">⟐</span>
      {subagentId}
    </span>
  );
}

// Assistant-message slot override. When the integration attributed this message
// to a subagent, prepend the subagent tag; otherwise render the default message
// untouched. Delegates all rendering (text, tool calls, toolbar) to the built-in
// component so behavior is identical apart from the tag.
type AssistantMessageProps = React.ComponentProps<
  typeof CopilotChatAssistantMessage
>;

function AssistantMessageWithSubagentTag(props: AssistantMessageProps) {
  const subagentId = getSubagentId(props.message);
  if (!subagentId) {
    return <CopilotChatAssistantMessage {...props} />;
  }
  return (
    <div className="subagent-message" data-testid="subagent-message">
      <SubagentTag subagentId={subagentId} />
      <CopilotChatAssistantMessage {...props} />
    </div>
  );
}

// Stable slot object (module-level) so CopilotChat's slot memoization isn't
// defeated by a fresh reference on every render. The cast satisfies the slot's
// `typeof CopilotChatAssistantMessage` type, which carries static namespace
// members the slot renderer never uses — our wrapper is a valid replacement.
const MESSAGE_VIEW_SLOTS = {
  assistantMessage:
    AssistantMessageWithSubagentTag as unknown as typeof CopilotChatAssistantMessage,
};

export default function DeepagentsSubagents({
  params,
}: DeepagentsSubagentsProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
    >
      <CopilotChatConfigurationProvider agentId={AGENT_ID}>
        <SubagentAttributionDemo />
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

function SubagentAttributionDemo() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Run the subagents",
        message:
          "Research the topic of octopus intelligence using your subagents and summarize the findings.",
      },
    ],
    available: "always",
  });

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId={AGENT_ID}
          className="h-full rounded-2xl max-w-6xl mx-auto"
          messageView={MESSAGE_VIEW_SLOTS}
        />
      </div>
    </div>
  );
}
