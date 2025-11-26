import { MenuIntegrationConfig } from "./types/integration";

export const menuIntegrations: MenuIntegrationConfig[] = [
  {
    id: "langgraph",
    name: "LangGraph (Python)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
      "subgraphs",
    ],
  },
  {
    id: "langgraph-fastapi",
    name: "LangGraph (FastAPI)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_chat_reasoning",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
      "subgraphs",
    ],
  },
  {
    id: "langgraph-typescript",
    name: "LangGraph (Typescript)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
      "subgraphs",
    ],
  },
  {
    id: "mastra",
    name: "Mastra",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "mastra-agent-local",
    name: "Mastra Agent (Local)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "spring-ai",
    name: "Spring AI",
    features: [
      "agentic_chat",
      "shared_state",
      "tool_based_generative_ui",
      "human_in_the_loop",
      "agentic_generative_ui",
    ],
  },
  {
    id: "pydantic-ai",
    name: "Pydantic AI",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      // Disabled until we can figure out why production builds break
      // "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "adk-middleware",
    name: "Google ADK",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "shared_state",
      "tool_based_generative_ui",
      // "predictive_state_updates"
    ],
  },
  {
    id: "microsoft-agent-framework-dotnet",
    name: "Microsoft Agent Framework (.NET)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "microsoft-agent-framework-python",
    name: "Microsoft Agent Framework (Python)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "agno",
    name: "Agno",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "llama-index",
    name: "LlamaIndex",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "shared_state",
    ],
  },
  {
    id: "crewai",
    name: "CrewAI",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "a2a-basic",
    name: "A2A (Direct)",
    features: ["vnext_chat"],
  },
  // Disabled until we can support Vercel AI SDK v5
  // {
  //   id: "vercel-ai-sdk",
  //   name: "Vercel AI SDK",
  //   features: ["agentic_chat"],
  // },
  {
    id: "middleware-starter",
    name: "Middleware Starter",
    features: ["agentic_chat"],
  },
  {
    id: "server-starter",
    name: "Server Starter",
    features: ["agentic_chat"],
  },
  {
    id: "server-starter-all-features",
    name: "Server Starter (All Features)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_chat_reasoning",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "a2a",
    name: "A2A",
    features: ["a2a_chat"],
  },
];
