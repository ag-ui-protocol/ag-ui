"use client";

import React, {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
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

interface UsageInfo {
  tokens: number;
  costUsd: number;
}

interface RunUsage {
  input?: UsageInfo;
  output?: UsageInfo;
}

const runUsage = new Map<string, RunUsage>();
const usageListeners = new Set<() => void>();

function setRunUsage(runId: string, update: RunUsage) {
  runUsage.set(runId, { ...runUsage.get(runId), ...update });
  usageListeners.forEach((listener) => listener());
}

function subscribeRunUsage(listener: () => void) {
  usageListeners.add(listener);
  return () => usageListeners.delete(listener);
}

function getRunUsage(runId?: string) {
  return runId ? runUsage.get(runId) : undefined;
}

function UsageLabel({
  message,
  position,
  runId,
}: {
  message: { role: string };
  position: "before" | "after";
  runId?: string;
}) {
  const usage = useSyncExternalStore(
    subscribeRunUsage,
    () => getRunUsage(runId),
    () => undefined,
  );

  if (
    message.role !== "assistant" ||
    position !== "after" ||
    (!usage?.input && !usage?.output)
  ) {
    return null;
  }

  return (
    <div
      className="mb-2 px-1 text-xs text-muted-foreground"
      aria-label="Run usage"
    >
      {usage.input && (
        <span>
          ⬇️ {usage.input.tokens} tokens · ${usage.input.costUsd.toFixed(6)}
        </span>
      )}
      {usage.input && usage.output && <span className="px-2"> </span>}
      {usage.output && (
        <span>
          ⬆️ {usage.output.tokens} tokens · ${usage.output.costUsd.toFixed(6)}
        </span>
      )}
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
  const currentRunId = useRef<string | undefined>(undefined);

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
      onRunStartedEvent: ({ event }) => {
        currentRunId.current = event.runId;
        runUsage.delete(event.runId);
        usageListeners.forEach((listener) => listener());
      },
      onCustomEvent: ({ event }) => {
        const runId = currentRunId.current;
        if (!runId) return;

        const value = event.value as { tokens: number; cost_usd: number };
        if (event.name === "input_usage") {
          setRunUsage(runId, {
            input: { tokens: value.tokens, costUsd: value.cost_usd },
          });
        }
        if (event.name === "output_usage") {
          setRunUsage(runId, {
            output: { tokens: value.tokens, costUsd: value.cost_usd },
          });
        }
      },
      onRunFinishedEvent: () => {
        currentRunId.current = undefined;
      },
      onRunErrorEvent: () => {
        currentRunId.current = undefined;
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
