import { AbstractAgent } from "@ag-ui/client";

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
 * Agent integration config
 * @template Id - The integration ID
 * @template F - The features available for this integration
 */
export interface AgentIntegrationConfig<
  Id extends string = string,
  F extends Feature = Feature
> {
  id: Id;
  agents: () => Promise<Partial<Record<F, AbstractAgent>>>;
}

/**
 * Helper type to extract features for a specific integration from menu config
 */
export type IntegrationFeatures<
  T extends readonly MenuIntegrationConfig[],
  Id extends string
> = Extract<T[number], { id: Id }>["features"][number];

/**
 * Helper function to create a type-safe agent config
 * Validates that agent keys match the features defined in menu.ts
 */
export function defineAgentConfig<
  Id extends string,
  F extends Feature
>(config: AgentIntegrationConfig<Id, F>): AgentIntegrationConfig<Id, F> {
  return config;
}
