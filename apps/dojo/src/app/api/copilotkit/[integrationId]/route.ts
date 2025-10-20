import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { agentsIntegrations } from "@/agents";
import type { AbstractAgent } from "@ag-ui/client";
import { handle } from "hono/vercel";

const serviceAdapter = new ExperimentalEmptyAdapter();

function extractIntegrationIdFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split("/"); // ["", "api", "copilotkit", "<id>", ...]
    const apiIdx = parts.indexOf("api");
    if (apiIdx !== -1 && parts[apiIdx + 1] === "copilotkit" && parts.length > apiIdx + 2) {
      return parts[apiIdx + 2] || null;
    }
    return parts.filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

async function buildAppForIntegration(integrationId: string) {
  const integration = agentsIntegrations.find((i) => i.id === integrationId);
  if (!integration) return null;

  const agentsPartial = await integration.agents();
  const entries = Object.entries(agentsPartial).filter(
    (entry): entry is [string, AbstractAgent] => Boolean(entry[1])
  );
  if (entries.length === 0) return null;
  const agents = Object.fromEntries(entries) as Record<string, AbstractAgent>;

  const runtime = new CopilotRuntime({
    // @ts-ignore for now
    agents,
  });
  const app = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: `/api/copilotkit/${integrationId}`,
  });
  return app;
}

export const GET = async (request: Request) => {
  const integrationId = extractIntegrationIdFromUrl(request.url);
  if (!integrationId) return new Response("Integration not found", { status: 404 });
  const app = await buildAppForIntegration(integrationId);
  if (!app) return new Response("Integration not found", { status: 404 });
  return handle(app)(request);
};

export const POST = async (request: Request) => {
  const integrationId = extractIntegrationIdFromUrl(request.url);
  if (!integrationId) return new Response("Integration not found", { status: 404 });
  const app = await buildAppForIntegration(integrationId);
  if (!app) return new Response("Integration not found", { status: 404 });
  return handle(app)(request);
};
