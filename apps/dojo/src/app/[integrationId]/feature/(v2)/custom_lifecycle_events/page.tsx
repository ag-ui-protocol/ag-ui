"use client";
import React, { useEffect, useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import { CopilotChat, useAgent, useConfigureSuggestions } from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

interface CustomLifecycleEventsProps {
  params: Promise<{ integrationId: string }>;
}

interface UsageInfo {
  tokens: number;
  costUsd: number;
}

const CustomLifecycleEvents: React.FC<CustomLifecycleEventsProps> = ({ params }) => {
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

// These names/shapes are whatever the server chose when it built the
// CustomEvent — translator_server.py's custom_lifecycle_events route calls
// build_input_usage_event()/build_output_usage_event()
// (agents_examples/custom_lifecycle_events.py) and passes the result into
// to_agui()'s start_custom_event/end_custom_event params, so one CUSTOM
// event goes out right after RUN_STARTED, another right before
// RUN_FINISHED. Nothing about the AG-UI CUSTOM event type dictates this
// shape; it's just what this demo's server-side code picked.
const Chat = () => {
  const { agent } = useAgent({ agentId: "custom_lifecycle_events" });
  const [inputUsage, setInputUsage] = useState<UsageInfo | null>(null);
  const [outputUsage, setOutputUsage] = useState<UsageInfo | null>(null);

  useConfigureSuggestions({
    suggestions: [
      { title: "Say hi", message: "Say hi in one sentence." },
      { title: "Tell a fact", message: "Tell me one interesting fact about space." },
    ],
    available: "always",
  });

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunStartedEvent: () => {
        setInputUsage(null);
        setOutputUsage(null);
      },
      onCustomEvent: ({ event }) => {
        if (event.name === "input_usage") {
          const value = event.value as { tokens: number; cost_usd: number };
          setInputUsage({ tokens: value.tokens, costUsd: value.cost_usd });
        }
        if (event.name === "output_usage") {
          const value = event.value as { tokens: number; cost_usd: number };
          setOutputUsage({ tokens: value.tokens, costUsd: value.cost_usd });
        }
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  return (
    <div className="flex flex-col h-full w-full items-center">
      <div className="w-full md:w-8/10 pt-4">
        <UsageMeter inputUsage={inputUsage} outputUsage={outputUsage} />
      </div>
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        <CopilotChat
          agentId="custom_lifecycle_events"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
};

function UsageMeter({
  inputUsage,
  outputUsage,
}: {
  inputUsage: UsageInfo | null;
  outputUsage: UsageInfo | null;
}) {
  if (!inputUsage && !outputUsage) {
    return (
      <div className="rounded-xl border border-dashed border-black/10 dark:border-white/10 p-4 text-xs text-black/40 dark:text-white/40">
        Send a message — a CUSTOM event reports fake input-token cost right after the run
        starts, another reports output-token cost right before it finishes.
      </div>
    );
  }

  const totalCost = (inputUsage?.costUsd ?? 0) + (outputUsage?.costUsd ?? 0);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-gradient-to-br from-slate-50 to-white dark:from-slate-900 dark:to-slate-800 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Usage (fake)
        </span>
        {inputUsage && outputUsage && (
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            ${totalCost.toFixed(6)} total
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <UsageSlot label="Input" emoji="⬇️" usage={inputUsage} pendingLabel="waiting for run…" />
        <UsageSlot label="Output" emoji="⬆️" usage={outputUsage} pendingLabel="pending run finish…" />
      </div>
    </div>
  );
}

function UsageSlot({
  label,
  emoji,
  usage,
  pendingLabel,
}: {
  label: string;
  emoji: string;
  usage: UsageInfo | null;
  pendingLabel: string;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 transition-colors ${
        usage
          ? "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40"
          : "border-black/10 dark:border-white/10"
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
        <span>{emoji}</span>
        <span>{label} tokens</span>
      </div>
      {usage ? (
        <>
          <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {usage.tokens}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            ${usage.costUsd.toFixed(6)}
          </div>
        </>
      ) : (
        <div className="text-xs italic text-slate-400 dark:text-slate-500 mt-1">
          {pendingLabel}
        </div>
      )}
    </div>
  );
}

export default CustomLifecycleEvents;
