import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpoint,
  BuiltInAgent,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import type { AbstractAgent } from "@ag-ui/client";
import { A2UIMiddleware, A2UI_PROMPT } from "@ag-ui/a2ui-middleware";

type RouteParams = {
  params: Promise<{
    integrationId: string;
    slug?: string[];
  }>;
};

const handlerCache = new Map<string, ReturnType<typeof handle>>();

const A2UI_SYSTEM_PROMPT = `You are a helpful assistant that can render rich UI surfaces using the A2UI protocol.

When the user asks for visual content (cards, forms, lists, buttons, etc.), use the send_a2ui_json_to_client tool to render A2UI surfaces.

${A2UI_PROMPT}`;

function getHandler(integrationId: string) {
  const cached = handlerCache.get(integrationId);
  if (cached) {
    return cached;
  }

  const builtInAgent = new BuiltInAgent({
    model: "openai/gpt-4o",
    prompt: A2UI_SYSTEM_PROMPT,
  });

  // Apply A2UI middleware - this injects the send_a2ui_json_to_client tool
  builtInAgent.use(new A2UIMiddleware({ systemInstructionsAdded: true }));

  const defaultAgent = builtInAgent as unknown as AbstractAgent;

  const runtime = new CopilotRuntime({
    agents: {
      default: defaultAgent,
    },
    runner: new InMemoryAgentRunner(),
  });

  const app = createCopilotEndpoint({
    runtime,
    basePath: `/api/copilotkita2ui/${integrationId}`,
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
