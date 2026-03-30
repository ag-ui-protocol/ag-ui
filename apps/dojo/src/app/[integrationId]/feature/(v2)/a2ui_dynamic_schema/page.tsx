"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { customCatalog } from "../a2ui_fixed_schema/custom-catalog";

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
          "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and star rating using the StarRating component.",
      },
      {
        title: "Product comparison",
        message:
          "Use the generate_a2ui tool to create a product comparison of 3 headphones with name, price, rating, a short description, and a Select button on each card.",
      },
      {
        title: "Team roster",
        message:
          "Use the generate_a2ui tool to create a team roster with 4 people showing name, role, avatar, and email.",
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
