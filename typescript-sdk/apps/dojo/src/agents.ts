import { AgentIntegrationConfig } from "./types/integration";
import { MiddlewareStarterAgent } from "@ag-ui/middleware-starter";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "@ag-ui/mastra";
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";

export const agentsIntegrations: AgentIntegrationConfig[] = [
  {
    id: "middleware-starter",
    agents: async () => {
      return {
        agentic_chat: new MiddlewareStarterAgent(),
      };
    },
  },
  {
    id: "mastra",
    agents: async () => {
      const mastraClient = new MastraClient({
        baseUrl: "http://localhost:4111",
      });

      return MastraAgent.getRemoteAgents({
        mastraClient,
      });
    },
  },
  {
    id: "vercel-ai-sdk",
    agents: async () => {
      return {
        agentic_chat: new VercelAISDKAgent({ model: openai("gpt-4o") }),
      };
    },
  },
];
