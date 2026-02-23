import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import type { AbstractAgent } from "@ag-ui/client";

import { agentsIntegrations } from "@/agents";
import { IntegrationId } from "@/menu";

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

  const runtime = new CopilotRuntime({
    agents: agents as Record<string, AbstractAgent>,
    runner: new InMemoryAgentRunner(),
  });

  const app = createCopilotEndpoint({
    runtime,
    basePath: `/api/copilotkit/${integrationId}`,
  });

  const handler = handle(app);
  handlerCache.set(integrationId, handler);
  return handler;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  if (!handler) {
    return new Response("Integration not found", { status: 404 });
  }
  return handler(request);
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  if (!handler) {
    return new Response("Integration not found", { status: 404 });
  }
  return handler(request);
}
