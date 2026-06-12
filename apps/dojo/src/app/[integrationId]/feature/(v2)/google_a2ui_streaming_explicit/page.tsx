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

// Proof-point (Option B): VISIBLE component-by-component streaming. The agent emits
// explicit literal-valued cards with a static children array (no template / no data
// model), so each card paints the moment its component streams in. Same bridge as
// google_a2ui_streaming (Google A2uiStreamParser → progressive activity snapshots, no
// middleware) — only the generation prompt differs. See GOOGLE_A2UI_PROOF_POINT.md.
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
      agentId="google_a2ui_streaming_explicit"
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
      agent="google_a2ui_streaming_explicit"
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
