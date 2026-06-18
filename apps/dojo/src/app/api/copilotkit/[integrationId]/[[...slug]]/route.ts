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

  // The AWS Strands a2ui demos are plain Strands agents with no a2ui tool
  // wiring: the runtime sends `injectA2UITool` and the adapter injects
  // `generate_a2ui` itself, inferring the model from the wrapped agent.
  // Scope it to the Strands integrations only (both adapters implement the
  // injection):
  // the LangGraph a2ui demos define their tools in-backend and must keep their
  // existing (no-injection) a2ui config so their passing tests are unaffected.
  const injectsA2UITool =
    integrationId === "aws-strands-typescript" || integrationId === "aws-strands";

  const runtime = new CopilotRuntime({
    agents: agents as Record<string, AbstractAgent>,
    runner: new InMemoryAgentRunner(),
    a2ui: {
      // For the Agent Framework (.NET) integration, a2ui_advanced is the
      // zero-configuration demo: agents.ts wraps it with its own A2UIMiddleware
      // (injectA2UITool scoped to that agent alone), so the runtime must not
      // apply a second middleware instance to it. Injecting render_a2ui into the
      // other a2ui agents is wrong everywhere — they carry their own A2UI flows
      // (direct tools / generate_a2ui subagent / recovery loop) that an extra
      // render tool would let the model bypass.
      agents:
        integrationId === "microsoft-agent-framework-dotnet"
          ? ["a2ui_fixed_schema", "a2ui_dynamic_schema", "a2ui_recovery"]
          : ["a2ui_fixed_schema", "a2ui_dynamic_schema", "a2ui_advanced", "a2ui_recovery"],
      // Catalog used when creating a surface from a STREAMED render_a2ui call.
      // Every agent that streams render_a2ui through this config (dynamic_schema,
      // recovery, and the non-.NET a2ui_advanced) renders against the dynamic
      // catalog; fixed_schema uses direct tools that carry their own catalog in
      // the result envelope, so a single catalog id here is correct.
      defaultCatalogId: "https://a2ui.org/demos/dojo/dynamic_catalog.json",
      ...(injectsA2UITool ? { injectA2UITool: true } : {}),
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
