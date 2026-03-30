"use client";
import React, { memo } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";
import {
  CopilotChat,
  useConfigureSuggestions,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import { customCatalog } from "../a2ui_fixed_schema/custom-catalog";
import { z } from "zod";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 1. Custom Progress Renderer for Dynamic A2UI
//    Overrides the built-in render_a2ui progress indicator with a branded
//    violet skeleton showing live component/item counters.
// ---------------------------------------------------------------------------

const A2UIProgress = memo(function A2UIProgress({
  parameters,
}: {
  parameters: Record<string, unknown>;
}) {
  const componentCount = Array.isArray(parameters?.components)
    ? parameters.components.length
    : 0;
  const itemCount = Array.isArray(parameters?.items)
    ? parameters.items.length
    : 0;

  return (
    <div className="rounded-xl border-2 border-violet-300 bg-gradient-to-br from-violet-50 via-white to-indigo-50 p-5 space-y-4 shadow-lg shadow-violet-100/50">
      {/* Header with branded spinner */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative h-8 w-8">
            <div className="absolute inset-0 rounded-full border-[3px] border-violet-200" />
            <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-violet-600 animate-spin" />
            <div className="absolute inset-[6px] rounded-full bg-violet-600/10" />
          </div>
          <div>
            <span className="text-sm font-semibold text-violet-900">
              Custom A2UI Progress
            </span>
            <p className="text-[11px] text-violet-500">
              useRenderTool(&quot;render_a2ui&quot;)
            </p>
          </div>
        </div>
        <span className="text-xs font-mono bg-violet-100 text-violet-700 px-2 py-1 rounded-full">
          {componentCount > 0 ? `${componentCount} nodes` : "parsing..."}
        </span>
      </div>

      {/* Live streaming counters */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-violet-100/60 p-2 text-center">
          <div className="text-lg font-bold text-violet-700">{componentCount}</div>
          <div className="text-[10px] uppercase tracking-wider text-violet-500">Components</div>
        </div>
        <div className="rounded-lg bg-indigo-100/60 p-2 text-center">
          <div className="text-lg font-bold text-indigo-700">{itemCount}</div>
          <div className="text-[10px] uppercase tracking-wider text-indigo-500">Data Items</div>
        </div>
        <div className="rounded-lg bg-purple-100/60 p-2 text-center">
          <div className="text-lg font-bold text-purple-700">
            {parameters?.root ? "1" : "0"}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-purple-500">Root Set</div>
        </div>
      </div>

      {/* Animated skeleton cards that light up as items stream in */}
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex-1 rounded-lg border border-violet-200/60 bg-white/80 p-3 space-y-2"
            style={{ opacity: itemCount > i ? 1 : 0.4, transition: "opacity 0.3s" }}
          >
            <div className="h-3 w-2/3 rounded-full bg-violet-200 animate-pulse" />
            <div className="h-2 w-full rounded-full bg-violet-100 animate-pulse" />
            <div className="h-2 w-4/5 rounded-full bg-violet-100 animate-pulse" />
            <div className="h-6 w-full rounded-md bg-violet-300/40 mt-2 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// 2. Frontend Action Handler (optimistic UI on button clicks)
//    Instant response when buttons are clicked — no server round-trip.
// ---------------------------------------------------------------------------

function useAdvancedA2UIFeatures() {
  // Custom progress renderer — overrides the built-in render_a2ui indicator
  useRenderTool(
    {
      name: "render_a2ui",
      parameters: z.any(),
      render: ({ status, parameters }) => {
        if (status === "complete") return <></>;
        return <A2UIProgress parameters={parameters ?? {}} />;
      },
    },
    [],
  );

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
      a2ui={{ catalogs: [customCatalog] }}
    >
      <div className="flex justify-center items-center h-full w-full">
        <div className="h-full w-full md:w-8/10 md:h-8/10 rounded-lg">
          <Chat />
        </div>
      </div>
    </CopilotKit>
  );
}
