import { AgentIntegrationConfig } from "./types/integration";
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

const envVars = getEnvVars();
export const agentsIntegrations: AgentIntegrationConfig[] = [
  {
    id: "server-starter-all-features",
    agents: async () => {
      return {
        agentic_chat: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterUrl}/agentic_chat`,
        }),
        human_in_the_loop: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterUrl}/human_in_the_loop`,
        }),
        agentic_generative_ui: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterUrl}/agentic_generative_ui`,
        }),
        tool_based_generative_ui: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterUrl}/tool_based_generative_ui`,
        }),
        shared_state: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterUrl}/shared_state`,
        }),
        predictive_state_updates: new ServerStarterAllFeaturesAgent({
          url: `${envVars.serverStarterUrl}/predictive_state_updates`,
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
