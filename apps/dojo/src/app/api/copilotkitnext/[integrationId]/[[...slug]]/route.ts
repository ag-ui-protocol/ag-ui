import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkitnext/runtime";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import type { AbstractAgent } from "@ag-ui/client";
import { agentsIntegrations } from "@/agents";
import type { IntegrationId } from "@/menu";

type RouteParams = {
  params: Promise<{
    integrationId: string;
    slug?: string[];
  }>;
};

const handlerCache = new Map<string, Promise<ReturnType<typeof handle> | null>>();

async function getHandler(integrationId: string) {
  const cached = handlerCache.get(integrationId);
  if (cached) {
    return await cached;
  }

  const createHandler = (async () => {
    const getAgents = agentsIntegrations[integrationId as IntegrationId];
    if (!getAgents) {
      return null;
    }

    const agents = (await getAgents()) as Record<string, AbstractAgent>;
    const defaultAgent =
      agents.vnext_chat ??
      agents.agentic_chat ??
      Object.values(agents)[0];

    if (!defaultAgent) {
      return null;
    }

    const runtime = new CopilotRuntime({
      agents: {
        ...agents,
        default: defaultAgent,
      },
      runner: new InMemoryAgentRunner(),
    });

    const app = createCopilotEndpoint({
      runtime,
      basePath: `/api/copilotkitnext/${integrationId}`,
    });

    return handle(app);
  })();

  handlerCache.set(integrationId, createHandler);

  try {
    const handler = await createHandler;
    if (!handler) {
      handlerCache.delete(integrationId);
    }
    return handler;
  } catch (error) {
    handlerCache.delete(integrationId);
    throw error;
  }
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
