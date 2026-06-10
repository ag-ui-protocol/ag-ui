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

  const agents = await getAgents();

  // Passing any `a2ui` config makes the runtime advertise `a2uiEnabled: true`
  // for the whole endpoint (the per-agent scoping below is not forwarded in
  // the runtime info response), and the client's CopilotKitProvider then
  // injects the A2UI catalog/schema/guidelines context (~30KB) into every
  // agent run it serves. Only enable it for integrations that actually have
  // a2ui agents (currently just langgraph).
  const a2uiAgentIds = ["a2ui_fixed_schema", "a2ui_dynamic_schema", "a2ui_advanced", "a2ui_recovery"];
  const hasA2uiAgents = a2uiAgentIds.some((id) => id in agents);

  const runtime = new CopilotRuntime({
    agents: agents as Record<string, AbstractAgent>,
    runner: new InMemoryAgentRunner(),
    ...(hasA2uiAgents
      ? {
          a2ui: {
            agents: a2uiAgentIds,
            // Catalog used when creating a surface from a STREAMED render_a2ui call.
            // Only the dynamic (subagent) agents stream; fixed_schema uses direct
            // tools that carry their own catalog in the result envelope, so a single
            // catalog id here is correct for every streaming agent.
            defaultCatalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
          },
        }
      : {}),
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
