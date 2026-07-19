"use client";

import React, { useEffect, useMemo, useSyncExternalStore } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  CopilotKitProvider,
  useAgent,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";

interface CustomLifecycleEventsProps {
  params: Promise<{ integrationId: string }>;
}

interface RunUsage {
  inputTokens: number;
  outputTokens: number;
}

// Keyed by the assistant message's own id rather than the framework's
// run id: CopilotKit's message-to-run mapping only resolves reliably for
// the first run in a session, so a run-id-keyed store silently drops usage
// on every later turn. Message ids don't have that problem.
const usageByMessageId = new Map<string, RunUsage>();
const usageListeners = new Set<() => void>();

function setMessageUsage(messageId: string, usage: RunUsage) {
  usageByMessageId.set(messageId, usage);
  usageListeners.forEach((listener) => listener());
}

function subscribeUsage(listener: () => void) {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

function getMessageUsage(messageId: string) {
  return usageByMessageId.get(messageId);
}

function UsageLabel({
  message,
  position,
}: {
  message: { id: string; role: string };
  position: "before" | "after";
}) {
  const usage = useSyncExternalStore(
    subscribeUsage,
    () => getMessageUsage(message.id),
    () => undefined,
  );
  if (message.role !== "assistant" || position !== "after" || !usage) {
    return null;
  }

  return (
    <div
      className="mb-2 px-1 text-xs text-muted-foreground"
      aria-label="Run usage"
    >
      ⬇️ {usage.inputTokens} input tokens · ⬆️ {usage.outputTokens} output
      tokens
    </div>
  );
}

const CustomLifecycleEvents: React.FC<CustomLifecycleEventsProps> = ({
  params,
}) => {
  const { integrationId } = React.use(params);
  const renderCustomMessages = useMemo(() => [{ render: UsageLabel }], []);

  return (
    <CopilotKitProvider
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      renderCustomMessages={renderCustomMessages}
    >
      <Chat />
    </CopilotKitProvider>
  );
};

const Chat = () => {
  const { agent } = useAgent({ agentId: "custom_lifecycle_events" });

  useConfigureSuggestions({
    suggestions: [
      { title: "Say hi", message: "Say hi in one sentence." },
      {
        title: "Tell me a fact about AI",
        message: "Tell me one interesting fact about AI.",
      },
    ],
    available: "before-first-message",
    consumerAgentId: "custom_lifecycle_events",
  });

  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event, messages }) => {
        if (event.name !== "run_usage") return;
        // run_usage fires after MESSAGES_SNAPSHOT, so the assistant's
        // reply is already the last message in this run's history.
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage) return;

        const value = event.value as {
          input_tokens: number;
          output_tokens: number;
        };
        setMessageUsage(lastMessage.id, {
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  return (
    <div className="flex h-full w-full items-center">
      <div className="h-full w-full md:h-8/10 md:w-8/10 rounded-lg">
        <CopilotChat
          agentId="custom_lifecycle_events"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

export default CustomLifecycleEvents;
