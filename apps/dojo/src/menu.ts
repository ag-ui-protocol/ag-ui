import type { MenuIntegrationConfig } from "./types/integration";
export * from "./types/integration";

/**
 * Integration configuration - SINGLE SOURCE OF TRUTH
 *
 * This file defines all integrations and their available features.
 * Used by:
 * - UI menu components
 * - proxy.ts (for route validation)
 * - agents.ts validates agent keys against these features
 */

export const menuIntegrations = [
  {
    id: "agent-spec-langgraph",
    name: "Open Agent Spec (LangGraph)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "agent-spec-wayflow",
    name: "Open Agent Spec (Wayflow)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "tool_based_generative_ui",
    ],
  },
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
      // "backend_tool_rendering",
      "human_in_the_loop",
      "agentic_generative_ui",
      "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
      "subgraphs",
    ],
  },
  // {
  //   id: "langchain",
  //   name: "LangChain",
  //   features: [
  //     "agentic_chat",
  //     "tool_based_generative_ui",
  //   ],
  // },
  {
    id: "mastra",
    name: "Mastra",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
      "tool_based_generative_ui",
    ],
  },
  {
    id: "mastra-agent-local",
    name: "Mastra Agent (Local)",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "human_in_the_loop",
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
      // TODO: @contextablemark Re-enable predictive state updates once it is working
      // "predictive_state_updates",
      "shared_state",
      "tool_based_generative_ui",
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
      "human_in_the_loop",
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
      // "backend_tool_rendering",
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
      // "agentic_chat_reasoning",
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
  {
    id: "aws-strands",
    name: "AWS Strands",
    features: [
      "agentic_chat",
      "backend_tool_rendering",
      "agentic_generative_ui",
      "shared_state",
      "human_in_the_loop",
    ],
  },
] as const satisfies readonly MenuIntegrationConfig[];
