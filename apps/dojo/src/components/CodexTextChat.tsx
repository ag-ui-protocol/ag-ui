"use client";

import { useEffect, useState } from "react";
import {
  CopilotChat,
  useAgent,
  useAgentContext,
} from "@copilotkit/react-core/v2";

export function CodexTextChat() {
  const { agent } = useAgent({ agentId: "agentic_chat" });
  const [failed, setFailed] = useState(false);
  useAgentContext({ description: "Name of the user", value: "Bob" });

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: () => setFailed(false),
      onRunErrorEvent: () => setFailed(true),
      onRunFailed: () => setFailed(true),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  return (
    <div className="flex justify-center items-center h-full w-full">
      <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
        {failed && (
          <p role="alert" className="px-4 py-2 text-red-700">
            Codex could not complete this run. Reload this page to start a new
            conversation.
          </p>
        )}
        <CopilotChat
          agentId="agentic_chat"
          className="h-full rounded-2xl max-w-6xl mx-auto"
        />
      </div>
    </div>
  );
}
