import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkitnext/runtime";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import { BasicAgent } from "@copilotkitnext/agent";

type RouteParams = {
  params: Promise<{
    integrationId: string;
    slug?: string[];
  }>;
};

const handlerCache = new Map<string, ReturnType<typeof handle>>();

function getHandler(integrationId: string) {
  const cached = handlerCache.get(integrationId);
  if (cached) {
    return cached;
  }

  const runtime = new CopilotRuntime({
    agents: {
      default: new BasicAgent({
        model: "openai/gpt-4o",
      }),
    },
    runner: new InMemoryAgentRunner(),
  });

  const app = createCopilotEndpoint({
    runtime,
    basePath: `/api/copilotkitnext/${integrationId}`,
  });

  const handler = handle(app);
  handlerCache.set(integrationId, handler);
  return handler;
}

export async function GET(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = getHandler(integrationId);
  return handler(request);
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = getHandler(integrationId);
  return handler(request);
}
