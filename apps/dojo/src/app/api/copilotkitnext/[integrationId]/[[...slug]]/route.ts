import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
  BuiltInAgent,
} from "@copilotkit/runtime/v2";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlerPromiseCache = new Map<string, Promise<any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHandler(integrationId: string): Promise<any> {
  const cached = handlerPromiseCache.get(integrationId);
  if (cached) {
    return cached;
  }

  const promise = createHandler(integrationId);
  handlerPromiseCache.set(integrationId, promise);
  return promise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createHandler(integrationId: string): Promise<any> {
  let agents: Record<string, AbstractAgent> = {};

  // Look up agents from agents.ts
  const getAgents = agentsIntegrations[integrationId as IntegrationId];
  if (getAgents) {
    agents = await getAgents() as Record<string, AbstractAgent>;
  }

  // Fallback to basic BuiltInAgent if no agents found
  if (Object.keys(agents).length === 0) {
    agents = {
      default: new BuiltInAgent({ model: "openai/gpt-4o" }) as unknown as AbstractAgent,
    };
  } else {
    // Also set the first agent as "default" for backwards compatibility
    const firstAgentKey = Object.keys(agents)[0];
    agents.default = agents[firstAgentKey];
  }

  const runtime = new CopilotRuntime({
    agents,
    runner: new InMemoryAgentRunner(),
  });

  const app = createCopilotEndpoint({
    runtime,
    basePath: `/api/copilotkitnext/${integrationId}`,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handle as any)(app);
}

export async function GET(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  return handler(request);
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  return handler(request);
}
