import {
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpointSingleRoute,
} from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import type { AbstractAgent } from "@ag-ui/client";

import { agentsIntegrations } from "@/agents";
import { IntegrationId } from "@/menu";
import flightSchema from "./streaming_flight_schema.json";
import bookedSchema from "./booked_schema.json";

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
    a2ui: {
      streamingSurfaces: [
        {
          toolName: "search_flights_streaming",
          surface: {
            surfaceId: "flight-search-streaming",
            catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
            components: flightSchema,
            dataKey: "flights",
            actionHandlers: {
              book_flight: [
                {
                  version: "v0.9",
                  createSurface: {
                    surfaceId: "flight-search-streaming",
                    catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
                  },
                },
                {
                  version: "v0.9",
                  updateComponents: {
                    surfaceId: "flight-search-streaming",
                    components: bookedSchema,
                  },
                },
                {
                  version: "v0.9",
                  updateDataModel: {
                    surfaceId: "flight-search-streaming",
                    value: {
                      title: "Booking Confirmed",
                      detail: "Your flight has been booked successfully.",
                      reference: "CK-38291",
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  });

  const app = createCopilotEndpointSingleRoute({
    runtime,
    basePath: `/api/copilotkit/${integrationId}`,
  });

  const handler = handle(app);
  handlerCache.set(integrationId, handler);
  return handler;
}

export async function POST(request: NextRequest, context: RouteParams) {
  const { integrationId } = await context.params;
  const handler = await getHandler(integrationId);
  if (!handler) {
    return new Response("Integration not found", { status: 404 });
  }
  return handler(request);
}
