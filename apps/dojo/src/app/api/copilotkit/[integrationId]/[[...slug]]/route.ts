import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpointSingleRoute,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import type { AbstractAgent } from "@ag-ui/client";

import { agentsIntegrations } from "@/agents";
import { IntegrationId } from "@/menu";
import { getPostHogClient } from "@/lib/posthog-server";

type RouteParams = {
  params: Promise<{
    integrationId: string;
    slug?: string[];
  }>;
};

const handlerCache = new Map<string, ReturnType<typeof handle>>();

async function getHandler(integrationId: string) {
  const cached = handlerCache.get(integrationId);
  if (cached) {
    return cached;
  }

  const getAgents = agentsIntegrations[integrationId as IntegrationId];
  if (!getAgents) {
    return null;
  }

  const agents = (await getAgents()) as Record<string, AbstractAgent>;

  // Mirror the v2 route: alias `default` to the first agent so CopilotKit
  // clients that don't pass an explicit `agent` prop still resolve cleanly.
  const firstAgentKey = Object.keys(agents)[0];
  if (firstAgentKey && !("default" in agents)) {
    agents.default = agents[firstAgentKey];
  }

  const runtime = new CopilotRuntime({
    agents,
    runner: new InMemoryAgentRunner(),
    a2ui: {
      agents: ["a2ui_fixed_schema", "a2ui_dynamic_schema", "a2ui_advanced"],
    },
  });

  const app = createCopilotEndpointSingleRoute({
    runtime,
    basePath: `/api/copilotkit/${integrationId}`,
  });

  const handler = handle(app);
  handlerCache.set(integrationId, handler);
  return handler;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  if (!handler) {
    return new Response("Integration not found", { status: 404 });
  }
  const distinctId = request.headers.get("x-posthog-distinct-id") || "anonymous";
  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId,
    event: "agent_api_request",
    properties: {
      integration_id: integrationId,
    },
  });
  return handler(request);
}
