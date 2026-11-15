/**
 * Cloudflare Agents Worker for the AG-UI Dojo.
 *
 * Each AG-UI thread maps to one `AgUiAgent` Durable Object (the Agents SDK
 * `Agent` class). The Worker forwards `POST /<feature>` to the thread's agent,
 * which runs an AI SDK v5 `streamText` call and streams it back as AG-UI
 * events over SSE through `AgentsToAGUIAdapter` + `createSSEResponse`.
 */
import { Agent, getAgentByName } from "agents";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type ToolSet } from "ai";
import { z } from "zod";
import { from } from "rxjs";
import type { RunAgentInput } from "@ag-ui/client";
import {
  AgentsToAGUIAdapter,
  createSSEResponse,
} from "@ag-ui/cloudflare-agents";
import { toModelMessages } from "./messages";

export interface Env {
  AgUiAgent: DurableObjectNamespace<AgUiAgent>;
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
}

type Feature = "agentic_chat" | "backend_tool_rendering";

const SYSTEM_PROMPTS: Record<Feature, string> = {
  agentic_chat:
    "You are the Cloudflare Agents Dojo assistant, running in a Durable Object. Be concise and helpful.",
  backend_tool_rendering:
    "You are the Cloudflare Agents Dojo forecaster. Call get_weather for any weather question.",
};

function isFeature(value: string): value is Feature {
  return value in SYSTEM_PROMPTS;
}

/** Frontend tools arrive in RunAgentInput; the client executes them, so no `execute`. */
function frontendTools(input: RunAgentInput): ToolSet {
  return Object.fromEntries(
    (input.tools ?? []).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(
          (t.parameters as Record<string, unknown>) ?? { type: "object" },
        ),
      }),
    ]),
  );
}

const backendTools: ToolSet = {
  get_weather: tool({
    description: "Get the current weather for a location.",
    inputSchema: z.object({ location: z.string() }),
    // Canned data keeps the demo deterministic and offline.
    execute: async ({ location }) => ({
      city: location,
      temperature: 20,
      conditions: "sunny",
      humidity: 50,
      windSpeed: 10,
      feelsLike: 25,
    }),
  }),
};

function contextPrompt(input: RunAgentInput): string {
  if (!input.context?.length) return "";
  return (
    "\n\nContext:\n" +
    input.context.map((c) => `- ${c.description}: ${c.value}`).join("\n")
  );
}

export class AgUiAgent extends Agent<Env> {
  private readonly adapter = new AgentsToAGUIAdapter();

  async onRequest(request: Request): Promise<Response> {
    const feature = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
    if (!isFeature(feature)) {
      return new Response(`Unknown feature: ${feature}`, { status: 404 });
    }

    const input = (await request.json()) as RunAgentInput;
    const openai = createOpenAI({
      baseURL: this.env.OPENAI_BASE_URL,
      apiKey: this.env.OPENAI_API_KEY || "sk-mock",
    });

    const stream = streamText({
      // Chat Completions, not the Responses API, so any OpenAI-compatible
      // endpoint (including aimock in CI) can serve it.
      model: openai.chat(this.env.OPENAI_MODEL),
      system: SYSTEM_PROMPTS[feature] + contextPrompt(input),
      messages: toModelMessages(input.messages),
      tools: {
        ...frontendTools(input),
        ...(feature === "backend_tool_rendering" ? backendTools : {}),
      },
      abortSignal: request.signal,
    });

    const events = this.adapter.adaptStreamToAGUI(
      stream,
      input.threadId,
      input.runId,
      input.messages,
      input.parentRunId,
      input.state as Record<string, unknown> | undefined,
      input.forwardedProps as Record<string, unknown> | undefined,
    );

    return createSSEResponse(from(events));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { threadId } = (await request.clone().json()) as RunAgentInput;
    if (!threadId) {
      return new Response("threadId is required", { status: 400 });
    }

    // One Durable Object per AG-UI thread.
    const agent = await getAgentByName(env.AgUiAgent, threadId);
    return agent.fetch(request);
  },
} satisfies ExportedHandler<Env>;
