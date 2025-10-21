import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { agentsIntegrations } from "@/agents";
import { handle } from 'hono/vercel'

import { NextRequest } from "next/server";

async function createApp(integrationId: string) {
  const integration = agentsIntegrations.find((i) => i.id === integrationId);
  if (!integration) {
    throw new Error(`Integration not found: ${integrationId}`);
  }
  const agents = await integration.agents();

  const runtime = new CopilotRuntime({
    // @ts-ignore for now
    agents,
  });

  return copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: `/api/copilotkit/${integrationId}`,
  });
}

async function routeHandler(
  request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;
  try {
    const app = await createApp(integrationId);
    return handle(app)(request);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Integration not found",
      { status: 404 }
    );
  }
}

export const GET = routeHandler;
export const POST = routeHandler;
