"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { customCatalog } from "./custom-catalog";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

function Chat() {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Search flights",
        message: "Find flights from SFO to JFK for next Tuesday.",
      },
      {
        title: "Search hotels",
        message: "Find hotels in downtown Manhattan for next weekend.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="a2ui_fixed_schema"
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
      agent="a2ui_fixed_schema"
      a2ui={{ catalog: customCatalog }}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
