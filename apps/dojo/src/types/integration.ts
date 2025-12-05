export type Feature =
  | "agentic_chat"
  | "agentic_generative_ui"
  | "human_in_the_loop"
  | "predictive_state_updates"
  | "shared_state"
  | "tool_based_generative_ui"
  | "backend_tool_rendering"
  | "agentic_chat_reasoning"
  | "subgraphs"
  | "a2a_chat"
  | "vnext_chat";

export interface MenuIntegrationConfig {
  id: string;
  name: string;
  features: Feature[];
}

/**
 * Helper type to extract features for a specific integration from menu config
 */
export type IntegrationFeatures<
  T extends readonly MenuIntegrationConfig[],
  Id extends string
> = Extract<T[number], { id: Id }>["features"][number];
