import "server-only";

import { AgentIntegrationConfig } from "./types/integration";
import { MiddlewareStarterAgent } from "@ag-ui/middleware-starter";
import { ServerStarterAgent } from "@ag-ui/server-starter";
import { ServerStarterAllFeaturesAgent } from "@ag-ui/server-starter-all-features";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "@ag-ui/mastra";
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";
import { LangGraphAgent } from "@ag-ui/langgraph";
import { AgnoAgent } from "@ag-ui/agno";
import { LlamaIndexAgent } from "@ag-ui/llamaindex";
import { CrewAIAgent } from "@ag-ui/crewai";
import getEnvVars from "./env";
import { mastra } from "./mastra";

const envVars = getEnvVars();
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
    id: "server-starter",
    agents: async () => {
      return {
        agentic_chat: new ServerStarterAgent({ url: envVars.serverStarterUrl }),
      };
    },
  },
  {
    id: "server-starter-all-features",
    agents: async () => {
      return {
        agentic_chat: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/agentic_chat`,
        }),
        human_in_the_loop: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/human_in_the_loop`,
        }),
        agentic_generative_ui: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/agentic_generative_ui`,
        }),
        tool_based_generative_ui: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/tool_based_generative_ui`,
        }),
        shared_state: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/shared_state`,
        }),
        predictive_state_updates: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterAllFeaturesUrl}/predictive_state_updates`,
        }),
      };
    },
  },
  {
    id: "mastra",
    agents: async () => {
      const mastraClient = new MastraClient({
        baseUrl: envVars.mastraUrl,
      });

      return MastraAgent.getRemoteAgents({
        mastraClient,
      });
    },
  },
  {
    id: "mastra-agent-local",
    agents: async () => {
      return MastraAgent.getLocalAgents({ mastra });
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
  {
    id: "langgraph",
    agents: async () => {
      return {
        agentic_chat: new LangGraphAgent({
          deploymentUrl: envVars.langgraphUrl,
          graphId: "agentic_chat",
        }),
        agentic_generative_ui: new LangGraphAgent({
          deploymentUrl: envVars.langgraphUrl,
          graphId: "agentic_generative_ui",
        }),
        human_in_the_loop: new LangGraphAgent({
          deploymentUrl: envVars.langgraphUrl,
          graphId: "human_in_the_loop",
        }),
        predictive_state_updates: new LangGraphAgent({
          deploymentUrl: envVars.langgraphUrl,
          graphId: "predictive_state_updates",
        }),
        shared_state: new LangGraphAgent({
          deploymentUrl: envVars.langgraphUrl,
          graphId: "shared_state",
        }),
        tool_based_generative_ui: new LangGraphAgent({
          deploymentUrl: envVars.langgraphUrl,
          graphId: "tool_based_generative_ui",
        }),
      };
    },
  },
  {
    id: "agno",
    agents: async () => {
      return {
        agentic_chat: new AgnoAgent({
          url: `${envVars.agnoUrl}/agui`,
        }),
      };
    },
  },
  {
    id: "llama-index",
    agents: async () => {
      return {
        agentic_chat: new LlamaIndexAgent({
          url: `${envVars.llamaIndexUrl}/agentic_chat/run`,
        }),
        human_in_the_loop: new LlamaIndexAgent({
          url: `${envVars.llamaIndexUrl}/human_in_the_loop/run`,
        }),
        agentic_generative_ui: new LlamaIndexAgent({
          url: `${envVars.llamaIndexUrl}/agentic_generative_ui/run`,
        }),
        shared_state: new LlamaIndexAgent({
          url: `${envVars.llamaIndexUrl}/shared_state/run`,
        }),
      };
    },
  },
  {
    id: "crewai",
    agents: async () => {
      return {
        agentic_chat: new CrewAIAgent({
          url: `${envVars.crewAiUrl}/agentic_chat`,
        }),
        human_in_the_loop: new CrewAIAgent({
          url: `${envVars.crewAiUrl}/human_in_the_loop`,
        }),
        tool_based_generative_ui: new CrewAIAgent({
          url: `${envVars.crewAiUrl}/tool_based_generative_ui`,
        }),
        agentic_generative_ui: new CrewAIAgent({
          url: `${envVars.crewAiUrl}/agentic_generative_ui`,
        }),
        shared_state: new CrewAIAgent({
          url: `${envVars.crewAiUrl}/shared_state`,
        }),
        predictive_state_updates: new CrewAIAgent({
          url: `${envVars.crewAiUrl}/predictive_state_updates`,
        }),
      };
    },
  },
];
