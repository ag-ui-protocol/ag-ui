"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { dynamicSchemaCatalog } from "@/a2ui-catalog";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

// Proof-point twin of a2ui_recovery. NOTE: Google's a2ui-agent-sdk has no bounded
// recovery loop — the `send_a2ui_json_to_client` tool validates once and, on failure,
// returns an error to the model (model-driven, unbounded retry). The A2UI middleware
// still paint-gates (an invalid surface never paints) and shows the "Retrying…" status,
// but there is no toolkit-style hard-failure ("Couldn't generate the UI") envelope.
function Chat() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Recover from an error",
        message: "Compare 3 luxury hotels with ratings and prices.",
      },
      {
        title: "Hard failure",
        message: "Compare 3 broken hotels with ratings and prices.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="google_a2ui_recovery"
      className="h-full rounded-2xl max-w-6xl mx-auto"
    />
  );
}

export default function Page({ params }: PageProps) {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="google_a2ui_recovery"
      a2ui={{
        catalog: dynamicSchemaCatalog,
        // Surface the "Retrying…" status immediately (the middleware emits it when it
        // suppresses an invalid attempt; here regeneration is model-driven).
        recovery: { showAfterMs: 0, showAfterAttempts: 1 },
      }}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
