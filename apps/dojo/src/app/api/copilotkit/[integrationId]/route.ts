import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { NextRequest } from "next/server";

import { agentsIntegrations } from "@/agents";
import { IntegrationId } from "@/menu";

export async function POST(request: NextRequest) {
  const integrationId = request.url.split("/").pop() as IntegrationId;

  const getAgents = agentsIntegrations[integrationId];
  if (!getAgents) {
    return new Response("Integration not found", { status: 404 });
  }

  const agents = await getAgents();
  const runtime = new CopilotRuntime({
    // @ts-ignore for now
    agents,
  });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: `/api/copilotkit/${integrationId}`,
  });

  return handleRequest(request);
}
