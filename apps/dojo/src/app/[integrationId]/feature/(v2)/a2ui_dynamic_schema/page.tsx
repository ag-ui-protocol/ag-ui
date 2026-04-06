"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { dynamicCatalog } from "./catalog";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

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
      agentId="a2ui_dynamic_schema"
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
      agent="a2ui_dynamic_schema"
      a2ui={{ catalog: dynamicCatalog }}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
