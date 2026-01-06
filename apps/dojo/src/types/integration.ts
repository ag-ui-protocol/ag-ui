import type { menuIntegrations } from "../menu";

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
type IntegrationFeature<
  T extends readonly MenuIntegrationConfig[],
  Id extends string
> = Extract<T[number], { id: Id }>["features"][number];

/** Type representing all valid integration IDs */
export type IntegrationId = (typeof menuIntegrations)[number]["id"];

/** Type to get features for a specific integration ID */
export type FeatureFor<Id extends IntegrationId> = IntegrationFeature<
  typeof menuIntegrations,
  Id
>;
