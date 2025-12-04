/**
 * Integration features data - used by both middleware and menu.ts
 * This is a plain data file without imports so it can be used in Edge runtime (middleware)
 */

export const INTEGRATION_FEATURES: Record<string, string[]> = {
  "langgraph": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "predictive_state_updates",
    "shared_state",
    "tool_based_generative_ui",
    "subgraphs",
  ],
  "langgraph-fastapi": [
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
  "langgraph-typescript": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "predictive_state_updates",
    "shared_state",
    "tool_based_generative_ui",
    "subgraphs",
  ],
  "mastra": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "tool_based_generative_ui",
  ],
  "mastra-agent-local": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "spring-ai": [
    "agentic_chat",
    "shared_state",
    "tool_based_generative_ui",
    "human_in_the_loop",
    "agentic_generative_ui",
  ],
  "pydantic-ai": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "adk-middleware": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "microsoft-agent-framework-dotnet": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "predictive_state_updates",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "microsoft-agent-framework-python": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "predictive_state_updates",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "agno": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "tool_based_generative_ui",
  ],
  "llama-index": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "shared_state",
  ],
  "crewai": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_generative_ui",
    "predictive_state_updates",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "a2a-basic": ["vnext_chat"],
  "middleware-starter": ["agentic_chat"],
  "server-starter": ["agentic_chat"],
  "server-starter-all-features": [
    "agentic_chat",
    "backend_tool_rendering",
    "human_in_the_loop",
    "agentic_chat_reasoning",
    "agentic_generative_ui",
    "predictive_state_updates",
    "shared_state",
    "tool_based_generative_ui",
  ],
  "a2a": ["a2a_chat"],
  "aws-strands": [
    "agentic_chat",
    "backend_tool_rendering",
    "agentic_generative_ui",
    "shared_state",
    "human_in_the_loop",
  ],
};

/**
 * Check if a feature is available for a given integration
 */
export function isFeatureAvailable(integrationId: string, featureId: string): boolean {
  const features = INTEGRATION_FEATURES[integrationId];
  return features ? features.includes(featureId) : false;
}

/**
 * Check if an integration exists
 */
export function isIntegrationValid(integrationId: string): boolean {
  return integrationId in INTEGRATION_FEATURES;
}

