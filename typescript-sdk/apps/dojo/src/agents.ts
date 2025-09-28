import "server-only";

import { AgentIntegrationConfig } from "./types/integration";
import { MiddlewareStarterAgent } from "@ag-ui/middleware-starter";
import { ServerStarterAgent } from "@ag-ui/server-starter";
import { ServerStarterAllFeaturesAgent } from "@ag-ui/server-starter-all-features";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "@ag-ui/mastra";
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "@ai-sdk/openai";
import { LangGraphAgent, LangGraphHttpAgent } from "@ag-ui/langgraph";
import { AgnoAgent } from "@ag-ui/agno";
import { LlamaIndexAgent } from "@ag-ui/llamaindex";
import { CrewAIAgent } from "@ag-ui/crewai";
import getEnvVars from "./env";
import { mastra } from "./mastra";
import { PydanticAIAgent } from "@ag-ui/pydantic-ai";
import { ADKAgent } from "@ag-ui/adk";

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
    id: "pydantic-ai",
    agents: async () => {
      return {
        agentic_chat: new PydanticAIAgent({
          url: `${envVars.pydanticAIUrl}/agentic_chat/`,
        }),
        agentic_generative_ui: new PydanticAIAgent({
          url: `${envVars.pydanticAIUrl}/agentic_generative_ui/`,
        }),
        human_in_the_loop: new PydanticAIAgent({
          url: `${envVars.pydanticAIUrl}/human_in_the_loop/`,
        }),
        // Disabled until we can figure out why production builds break
        // predictive_state_updates: new PydanticAIAgent({
        //   url: `${envVars.pydanticAIUrl}/predictive_state_updates/`,
        // }),
        shared_state: new PydanticAIAgent({
          url: `${envVars.pydanticAIUrl}/shared_state/`,
        }),
        tool_based_generative_ui: new PydanticAIAgent({
          url: `${envVars.pydanticAIUrl}/tool_based_generative_ui/`,
        }),
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
    id: "adk-middleware",
    agents: async () => {
      return {
        agentic_chat: new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/chat` }),
        tool_based_generative_ui: new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/adk-tool-based-generative-ui` }),
        human_in_the_loop: new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/adk-human-in-loop-agent` }),
        shared_state: new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/adk-shared-state-agent` }),
        // predictive_state_updates: new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/adk-predictive-state-agent` }),
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
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "agentic_chat",
        }),
        agentic_generative_ui: new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "agentic_generative_ui",
        }),
        human_in_the_loop: new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "human_in_the_loop",
        }),
        predictive_state_updates: new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "predictive_state_updates",
        }),
        shared_state: new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "shared_state",
        }),
        tool_based_generative_ui: new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "tool_based_generative_ui",
        }),
        agentic_chat_reasoning: new LangGraphHttpAgent({
          url: `${envVars.langgraphPythonUrl}/agent/agentic_chat_reasoning`,
        }),
        subgraphs: new LangGraphAgent({
          deploymentUrl: envVars.langgraphPythonUrl,
          graphId: "subgraphs",
        }),
      };
    },
  },
  {
    id: "langgraph-fastapi",
    agents: async () => {
      return {
        agentic_chat: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/agentic_chat`,
        }),
        agentic_generative_ui: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/agentic_generative_ui`,
        }),
        human_in_the_loop: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/human_in_the_loop`,
        }),
        predictive_state_updates: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/predictive_state_updates`,
        }),
        shared_state: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/shared_state`,
        }),
        tool_based_generative_ui: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/tool_based_generative_ui`,
        }),
        agentic_chat_reasoning: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/agentic_chat_reasoning`,
        }),
        subgraphs: new LangGraphHttpAgent({
          url: `${envVars.langgraphFastApiUrl}/agent/subgraphs`,
        }),
      };
    },
  },
  {
    id: "langgraph-typescript",
    agents: async () => {
      return {
        agentic_chat: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "agentic_chat",
        }),
        agentic_generative_ui: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "agentic_generative_ui",
        }),
        human_in_the_loop: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "human_in_the_loop",
        }),
        predictive_state_updates: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "predictive_state_updates",
        }),
        shared_state: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "shared_state",
        }),
        tool_based_generative_ui: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "tool_based_generative_ui",
        }),
        subgraphs: new LangGraphAgent({
          deploymentUrl: envVars.langgraphTypescriptUrl,
          graphId: "subgraphs",
        })
      };
    },
  },
  {
    id: "agno",
    agents: async () => {
      return {
        agentic_chat: new AgnoAgent({
          url: `${envVars.agnoUrl}/agentic_chat/agui`,
        }),
        tool_based_generative_ui: new AgnoAgent({
          url: `${envVars.agnoUrl}/tool_based_generative_ui/agui`,
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
