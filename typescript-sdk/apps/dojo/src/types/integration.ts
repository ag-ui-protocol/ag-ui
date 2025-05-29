import { AbstractAgent } from "@ag-ui/client";

export type Feature =
  | "agentic_chat"
  | "agentic_generative_ui"
  | "human_in_the_loop"
  | "predictive_state_updates"
  | "shared_state"
  | "tool_based_generative_ui";

export interface IntegrationConfig<TFeatures extends Feature[]> {
  id: string;
  name: string;
  features: TFeatures;
  agents: () => Promise<Record<TFeatures[number], AbstractAgent>>;
}

export function configureIntegration<TFeatures extends Feature[]>(
  config: IntegrationConfig<TFeatures>,
) {
  return config;
}
