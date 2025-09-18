import { MenuIntegrationConfig } from "./types/integration";

export const menuIntegrations: MenuIntegrationConfig[] = [
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
    id: "adk-middleware",
    name: "ADK Middleware",
    features: [
      "agentic_chat",
      "human_in_the_loop",
      "shared_state",
      "tool_based_generative_ui",
      // "predictive_state_updates"
    ],
  },
  {
    id: "server-starter-all-features",
    name: "Server Starter (All Features)",
    features: [
      "agentic_chat",
      "human_in_the_loop",
      "agentic_chat_reasoning",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "agno",
    name: "Agno",
    features: ["agentic_chat", "tool_based_generative_ui"],
  },
  {
    id: "crewai",
    name: "CrewAI",
    features: [
      "agentic_chat",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "langgraph",
    name: "LangGraph (Python)",
    features: [
      "agentic_chat",
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
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
      "subgraphs",
    ],
  },
  {
    id: "llama-index",
    name: "LlamaIndex",
    features: ["agentic_chat", "human_in_the_loop", "agentic_generative_ui", "shared_state"],

  },
  {
    id: "mastra",
    name: "Mastra",
    features: ["agentic_chat", "tool_based_generative_ui"],
  },
  {
    id: "mastra-agent-local",
    name: "Mastra Agent (Local)",
    features: ["agentic_chat", "shared_state", "tool_based_generative_ui"],
  },
  {
    id: "pydantic-ai",
    name: "Pydantic AI",
    features: [
      "agentic_chat",
      "human_in_the_loop",
      "agentic_generative_ui",
      // Disabled until we can figure out why production builds break
      // "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "vercel-ai-sdk",
    name: "Vercel AI SDK",
    features: ["agentic_chat"],
  },
];

