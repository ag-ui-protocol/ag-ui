import "server-only";

import type { AbstractAgent } from "@ag-ui/client";
import type { AgentsMap } from "./types/agents";
import { mapAgents } from "./utils/agents";
import { MiddlewareStarterAgent } from "@ag-ui/middleware-starter";
import { ServerStarterAgent } from "@ag-ui/server-starter";
import { ServerStarterAllFeaturesAgent } from "@ag-ui/server-starter-all-features";
import { MastraClient } from "@mastra/client-js";
import { MastraAgent } from "@ag-ui/mastra";
// import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
// import { openai } from "@ai-sdk/openai";
import { LangGraphAgent, LangGraphHttpAgent } from "@ag-ui/langgraph";
import { AgnoAgent } from "@ag-ui/agno";
import { LlamaIndexAgent } from "@ag-ui/llamaindex";
import { CrewAIAgent } from "@ag-ui/crewai";
import getEnvVars from "./env";
import { mastra } from "./mastra";
import { PydanticAIAgent } from "@ag-ui/pydantic-ai";
import { ADKAgent } from "@ag-ui/adk";
import { SpringAiAgent } from "@ag-ui/spring-ai";
import { HttpAgent, secureToolsMiddleware, type ToolSpec } from "@ag-ui/client";
import { A2AMiddlewareAgent } from "@ag-ui/a2a-middleware";
import { AWSStrandsAgent } from "@ag-ui/aws-strands";
import { A2AAgent } from "@ag-ui/a2a";
import { A2AClient } from "@a2a-js/sdk/client";
import { LangChainAgent } from "@ag-ui/langchain";

// Tool specifications for secure_tools demo
const secureToolsAllowedTools: ToolSpec[] = [
  {
    name: "change_background",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.",
    parameters: {
      type: "object",
      properties: {
        background: {
          type: "string",
          description: "The background. Prefer gradients. Only use when asked.",
        },
      },
      required: ["background"],
    },
  },
  // Note: "say_hello" is intentionally NOT in this list to demonstrate blocking
];

/**
 * Helper to wrap an agent with SecureToolsMiddleware for the secure_tools demo.
 * This demonstrates blocking unauthorized tool calls.
 */
function wrapWithSecureTools<T extends AbstractAgent>(agent: T): T {
  agent.use(
    secureToolsMiddleware({
      allowedTools: secureToolsAllowedTools,
      onDeviation: (deviation) => {
        console.warn(
          `[SecureTools Demo] Blocked tool call: ${deviation.toolCall.toolCallName}`,
          { reason: deviation.reason, message: deviation.message }
        );
      },
    })
  );
  return agent;
}

const envVars = getEnvVars();

export const agentsIntegrations = {
  "middleware-starter": async () => ({
    agentic_chat: new MiddlewareStarterAgent(),
  }),

  "pydantic-ai": async () => ({
    ...mapAgents(
      (path) => new PydanticAIAgent({ url: `${envVars.pydanticAIUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        // TODO: Re-enable this once production builds no longer break
        // predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        backend_tool_rendering: "backend_tool_rendering",
      }
    ),
    secure_tools: wrapWithSecureTools(new PydanticAIAgent({ url: `${envVars.pydanticAIUrl}/agentic_chat` })),
  }),

  "server-starter": async () => ({
    agentic_chat: new ServerStarterAgent({ url: envVars.serverStarterUrl }),
  }),

  "adk-middleware": async () => ({
    ...mapAgents(
      (path) => new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/${path}` }),
      {
        agentic_chat: "chat",
        agentic_generative_ui: "adk-agentic-generative-ui",
        tool_based_generative_ui: "adk-tool-based-generative-ui",
        human_in_the_loop: "adk-human-in-loop-agent",
        backend_tool_rendering: "backend_tool_rendering",
        shared_state: "adk-shared-state-agent",
        // TODO: @contextablemark Re-enable predictive state updates once it is working
        // predictive_state_updates: "adk-predictive-state-agent",
      }
    ),
    secure_tools: wrapWithSecureTools(new ADKAgent({ url: `${envVars.adkMiddlewareUrl}/chat` })),
  }),

  "server-starter-all-features": async () => ({
    ...mapAgents(
      (path) => new ServerStarterAllFeaturesAgent({ url: `${envVars.serverStarterAllFeaturesUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        // TODO: Add agent for agentic_chat_reasoning
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        tool_based_generative_ui: "tool_based_generative_ui",
        shared_state: "shared_state",
        predictive_state_updates: "predictive_state_updates",
      }
    ),
    secure_tools: wrapWithSecureTools(
      new ServerStarterAllFeaturesAgent({ url: `${envVars.serverStarterAllFeaturesUrl}/agentic_chat` })
    ),
  }),

  mastra: async () => {
    const mastraClient = new MastraClient({
      baseUrl: envVars.mastraUrl,
    });

    return MastraAgent.getRemoteAgents({
      mastraClient,
    }) as Promise<Record<"agentic_chat" | "backend_tool_rendering" | "human_in_the_loop" | "tool_based_generative_ui", AbstractAgent>>;
  },

  "mastra-agent-local": async () => {
    return MastraAgent.getLocalAgents({
      mastra,
    }) as Record<"agentic_chat" | "backend_tool_rendering" | "human_in_the_loop" | "shared_state" | "tool_based_generative_ui", AbstractAgent>;
  },

  // Disabled until we can support Vercel AI SDK v5
  // "vercel-ai-sdk": async () => ({
  //   agentic_chat: new VercelAISDKAgent({ model: openai("gpt-4o") }),
  // }),

  langgraph: async () => ({
    ...mapAgents(
      (graphId) => new LangGraphAgent({ deploymentUrl: envVars.langgraphPythonUrl, graphId }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        subgraphs: "subgraphs",
      }
    ),
    // Uses LangGraphHttpAgent instead of LangGraphAgent
    agentic_chat_reasoning: new LangGraphHttpAgent({
      url: `${envVars.langgraphPythonUrl}/agent/agentic_chat_reasoning`,
    }),
    secure_tools: wrapWithSecureTools(
      new LangGraphAgent({ deploymentUrl: envVars.langgraphPythonUrl, graphId: "agentic_chat" })
    ),
  }),

  "langgraph-fastapi": async () => ({
    ...mapAgents(
      (path) => new LangGraphHttpAgent({ url: `${envVars.langgraphFastApiUrl}/agent/${path}` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        agentic_chat_reasoning: "agentic_chat_reasoning",
        subgraphs: "subgraphs",
      }
    ),
    secure_tools: wrapWithSecureTools(
      new LangGraphHttpAgent({ url: `${envVars.langgraphFastApiUrl}/agent/agentic_chat` })
    ),
  }),

  "langgraph-typescript": async () => ({
    ...mapAgents(
      (graphId) => new LangGraphAgent({ deploymentUrl: envVars.langgraphTypescriptUrl, graphId }),
      {
        agentic_chat: "agentic_chat",
        // TODO: Add agent for backend_tool_rendering
        agentic_generative_ui: "agentic_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        predictive_state_updates: "predictive_state_updates",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        subgraphs: "subgraphs",
      }
    ),
    secure_tools: wrapWithSecureTools(
      new LangGraphAgent({ deploymentUrl: envVars.langgraphTypescriptUrl, graphId: "agentic_chat" })
    ),
  }),

  // TODO: @ranst91 Enable `langchain` integration in apps/dojo/src/menu.ts once ready
  langchain: async () => {
    const agent = new LangChainAgent({
      chainFn: async ({ messages, tools, threadId }) => {
        const { ChatOpenAI } = await import("@langchain/openai");
        const chatOpenAI = new ChatOpenAI({ model: "gpt-4o" });
        const model = chatOpenAI.bindTools(tools, {
          strict: true,
        });
        return model.stream(messages, { tools, metadata: { conversation_id: threadId } });
      },
    });
    return {
      agentic_chat: agent,
      tool_based_generative_ui: agent,
    };
  },

  agno: async () => ({
    ...mapAgents(
      (path) => new AgnoAgent({ url: `${envVars.agnoUrl}/${path}/agui` }),
      {
        agentic_chat: "agentic_chat",
        tool_based_generative_ui: "tool_based_generative_ui",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
      }
    ),
    secure_tools: wrapWithSecureTools(new AgnoAgent({ url: `${envVars.agnoUrl}/agentic_chat/agui` })),
  }),

  "spring-ai": async () => ({
    ...mapAgents(
      (path) => new SpringAiAgent({ url: `${envVars.springAiUrl}/${path}/agui` }),
      {
        agentic_chat: "agentic_chat",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
      }
    ),
    secure_tools: wrapWithSecureTools(new SpringAiAgent({ url: `${envVars.springAiUrl}/agentic_chat/agui` })),
  }),

  "llama-index": async () => ({
    ...mapAgents(
      (path) => new LlamaIndexAgent({ url: `${envVars.llamaIndexUrl}/${path}/run` }),
      {
        agentic_chat: "agentic_chat",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        backend_tool_rendering: "backend_tool_rendering",
      }
    ),
    secure_tools: wrapWithSecureTools(new LlamaIndexAgent({ url: `${envVars.llamaIndexUrl}/agentic_chat/run` })),
  }),

  crewai: async () => ({
    ...mapAgents(
      (path) => new CrewAIAgent({ url: `${envVars.crewAiUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        // TODO: Add agent for backend_tool_rendering
        // backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        tool_based_generative_ui: "tool_based_generative_ui",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        predictive_state_updates: "predictive_state_updates",
      }
    ),
    secure_tools: wrapWithSecureTools(new CrewAIAgent({ url: `${envVars.crewAiUrl}/agentic_chat` })),
  }),

  "agent-spec-langgraph": async () => ({
    ...mapAgents(
      (path) => new HttpAgent({
        url: `${envVars.agentSpecUrl}/langgraph/${path}`,
      }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        tool_based_generative_ui: "tool_based_generative_ui",
      }
    ),
    secure_tools: wrapWithSecureTools(new HttpAgent({ url: `${envVars.agentSpecUrl}/langgraph/agentic_chat` })),
  }),

  "agent-spec-wayflow": async () => ({
    ...mapAgents(
      (path) => new HttpAgent({
        url: `${envVars.agentSpecUrl}/wayflow/${path}`,
      }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        tool_based_generative_ui: "tool_based_generative_ui",
        human_in_the_loop: "human_in_the_loop",
      }
    ),
    secure_tools: wrapWithSecureTools(new HttpAgent({ url: `${envVars.agentSpecUrl}/wayflow/agentic_chat` })),
  }),

  "microsoft-agent-framework-python": async () => ({
    ...mapAgents(
      (path) => new HttpAgent({ url: `${envVars.agentFrameworkPythonUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        predictive_state_updates: "predictive_state_updates",
      }
    ),
    secure_tools: wrapWithSecureTools(new HttpAgent({ url: `${envVars.agentFrameworkPythonUrl}/agentic_chat` })),
  }),

  "a2a-basic": async () => {
    const a2aClient = new A2AClient(envVars.a2aUrl);
    return {
      vnext_chat: new A2AAgent({
        description: "Direct A2A agent",
        a2aClient,
        debug: process.env.NODE_ENV !== "production",
      }),
    };
  },

  "microsoft-agent-framework-dotnet": async () => ({
    ...mapAgents(
      (path) => new HttpAgent({ url: `${envVars.agentFrameworkDotnetUrl}/${path}` }),
      {
        agentic_chat: "agentic_chat",
        backend_tool_rendering: "backend_tool_rendering",
        human_in_the_loop: "human_in_the_loop",
        agentic_generative_ui: "agentic_generative_ui",
        shared_state: "shared_state",
        tool_based_generative_ui: "tool_based_generative_ui",
        predictive_state_updates: "predictive_state_updates",
      }
    ),
    secure_tools: wrapWithSecureTools(new HttpAgent({ url: `${envVars.agentFrameworkDotnetUrl}/agentic_chat` })),
  }),

  a2a: async () => {
    // A2A agents: building management, finance, it agents
    const agentUrls = [
      envVars.a2aMiddlewareBuildingsManagementUrl,
      envVars.a2aMiddlewareFinanceUrl,
      envVars.a2aMiddlewareItUrl,
    ];
    // AGUI orchestration/routing agent
    const orchestrationAgent = new HttpAgent({
      url: envVars.a2aMiddlewareOrchestratorUrl,
    });
    return {
      a2a_chat: new A2AMiddlewareAgent({
        description: "Middleware that connects to remote A2A agents",
        agentUrls,
        orchestrationAgent,
        instructions: `
          You are an HR agent. You are responsible for hiring employees and other typical HR tasks.

          It's very important to contact all the departments necessary to complete the task.
          For example, to hire an employee, you must contact all 3 departments: Finance, IT and Buildings Management. Help the Buildings Management department to find a table.

          You can make tool calls on behalf of other agents.
          DO NOT FORGET TO COMMUNICATE BACK TO THE RELEVANT AGENT IF MAKING A TOOL CALL ON BEHALF OF ANOTHER AGENT!!!

          When choosing a seat with the buildings management agent, You MUST use the \`pickTable\` tool to have the user pick a seat.
          The buildings management agent will then use the \`pickSeat\` tool to pick a seat.
          `,
      }),
    };
  },

  "aws-strands": async () => ({
    // Different URL pattern (hyphens) and one has debug:true, so not using mapAgents
    ...mapAgents(
      (path) => new AWSStrandsAgent({ url: `${envVars.awsStrandsUrl}/${path}/` }),
      {
        agentic_chat: "agentic-chat",
        backend_tool_rendering: "backend-tool-rendering",
        agentic_generative_ui: "agentic-generative-ui",
        shared_state: "shared-state",
      }
    ),
    human_in_the_loop: new AWSStrandsAgent({ url: `${envVars.awsStrandsUrl}/human-in-the-loop`, debug: true }),
    secure_tools: wrapWithSecureTools(new AWSStrandsAgent({ url: `${envVars.awsStrandsUrl}/agentic-chat/` })),
  }),
} satisfies AgentsMap;
