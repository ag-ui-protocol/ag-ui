import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { agentsIntegrations } from "@/agents";

import { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const integrationId = request.url.split("/").pop();

  const integration = agentsIntegrations.find((i) => i.id === integrationId);
  if (!integration) {
    return new Response("Integration not found", { status: 404 });
  }
  const agents = await integration.agents();
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
