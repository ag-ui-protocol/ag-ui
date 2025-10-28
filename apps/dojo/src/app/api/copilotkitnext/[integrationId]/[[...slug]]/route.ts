import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
} from "@copilotkitnext/runtime";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";

type RouteParams = {
  params: {
    integrationId: string;
    slug?: string[];
  };
};

function createHandler(integrationId: string) {
  const runtime = new CopilotRuntime({
    agents: {
      default: null as any,
    },
    runner: new InMemoryAgentRunner(),
  });

  const app = createCopilotEndpoint({
    runtime,
    basePath: `/api/copilotkitnext/${integrationId}`,
  });

  return handle(app);
}

export function GET(request: NextRequest, context: RouteParams) {
  const handler = createHandler(context.params.integrationId);
  return handler(request);
}

export function POST(request: NextRequest, context: RouteParams) {
  const handler = createHandler(context.params.integrationId);
  return handler(request);
}

