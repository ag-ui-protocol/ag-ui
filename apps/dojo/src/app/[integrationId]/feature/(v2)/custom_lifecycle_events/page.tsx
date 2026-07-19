"use client";

import React, { useEffect, useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  CopilotChat,
  useAgent,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface CustomLifecycleEventsProps {
  params: Promise<{ integrationId: string }>;
}

interface RunUsage {
  inputTokens: number;
  outputTokens: number;
}

const CustomLifecycleEvents: React.FC<CustomLifecycleEventsProps> = ({
  params,
}) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="custom_lifecycle_events"
    >
      <Chat />
    </CopilotKit>
  );
};

const Chat = () => {
  const { agent } = useAgent({ agentId: "custom_lifecycle_events" });
  const [usage, setUsage] = useState<RunUsage | null>(null);

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
      onCustomEvent: ({ event }) => {
        if (event.name !== "run_usage") return;
        const value = event.value as {
          input_tokens: number;
          output_tokens: number;
        };
        setUsage({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
        });
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      {usage && (
        <div
          className="px-1 text-xs text-muted-foreground"
          aria-label="Run usage"
        >
          ⬇️ {usage.inputTokens} input tokens · ⬆️ {usage.outputTokens} output
          tokens
        </div>
      )}
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
