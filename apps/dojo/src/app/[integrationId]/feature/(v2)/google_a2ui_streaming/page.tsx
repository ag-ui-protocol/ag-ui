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

// Proof-point (Option A): progressive A2UI via Google's A2uiStreamParser. The ADK
// agent emits `a2ui-surface` ACTIVITY_SNAPSHOT events directly as Google's parser
// yields components, so the surface fills in progressively. No A2UI middleware is
// attached for this demo — see GOOGLE_A2UI_PROOF_POINT.md.
function Chat() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Hotel comparison",
        message:
          "Compare 3 luxury hotels in different cities with ratings and prices.",
      },
      {
        title: "Product comparison",
        message:
          "Compare 3 wireless headphones with prices, ratings, and descriptions.",
      },
      {
        title: "Team roster",
        message:
          "Show a team of 4 people with their roles, departments, and contact info.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="google_a2ui_streaming"
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
      agent="google_a2ui_streaming"
      a2ui={{ catalog: dynamicSchemaCatalog }}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
