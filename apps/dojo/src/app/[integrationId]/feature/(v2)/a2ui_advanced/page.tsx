"use client";
import React from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
  useA2UIActionHandler,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Frontend Action Handler (optimistic UI on button clicks)
//
// When the user clicks a button in the A2UI surface, this handler fires
// instantly — no server round-trip needed. It can return custom A2UI
// operations for immediate feedback, or fall back to the agent's
// pre-declared ops.
//
// This is a key advanced pattern: the same dynamic schema agent is used,
// but the frontend adds instant interactivity via useA2UIActionHandler.
// Compare with the "A2UI Dynamic Schema" demo which has no action handler.
//
// NOTE: Custom progress rendering via useRenderTool("render_a2ui") requires
// CopilotKit infrastructure changes to coordinate with the built-in A2UI
// progress renderer. This will be added in a future update.
// ---------------------------------------------------------------------------

function useAdvancedA2UIFeatures() {
  // Optimistic action handler for button clicks
  useA2UIActionHandler((action, declaredOps) => {
    // Use pre-declared ops from the agent if available
    if (declaredOps) return declaredOps;

    // Otherwise, show a generic confirmation
    const { surfaceId } = action;
    return [
      {
        surfaceUpdate: {
          surfaceId,
          components: [
            {
              id: "root",
              component: {
                Card: { child: "confirm-col" },
              },
            },
            {
              id: "confirm-col",
              component: {
                Column: {
                  children: { explicitList: ["confirm-title", "confirm-detail"] },
                  alignment: "center",
                  gap: "small",
                },
              },
            },
            {
              id: "confirm-title",
              component: {
                Text: {
                  text: { path: "/title" },
                  usageHint: "h2",
                },
              },
            },
            {
              id: "confirm-detail",
              component: {
                Text: {
                  text: { path: "/detail" },
                  usageHint: "body",
                },
              },
            },
          ],
        },
      },
      {
        dataModelUpdate: {
          surfaceId,
          contents: [
            { key: "title", valueString: "Action Received" },
            {
              key: "detail",
              valueString: `"${action.name}" triggered${action.context ? ` with ${JSON.stringify(action.context)}` : ""}.`,
            },
          ],
        },
      },
      { beginRendering: { surfaceId, root: "root" } },
    ];
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ integrationId: string }>;
}

function Chat() {
  useAdvancedA2UIFeatures();

  useConfigureSuggestions({
    suggestions: [
      {
        title: "Product comparison",
        message:
          "Use the generate_a2ui tool to create a product comparison of 3 headphones with name, price, rating, a short description, and a Select button on each card.",
      },
      {
        title: "Team directory",
        message:
          "Use the generate_a2ui tool to create a team directory with 4 people showing name, role, department, and a Contact button.",
      },
    ],
    available: "always",
  });

  return (
    <CopilotChat
      agentId="a2ui_advanced"
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
      agent="a2ui_advanced"
      a2ui={{}}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
