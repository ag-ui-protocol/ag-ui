import { IntegrationConfig } from "./types/integration";
import { featureConfig } from "./config";
import { StarterAgent } from "@ag-ui/starter";
export const integrations: IntegrationConfig[] = [];

// A helper method to configure
function configureIntegration({ id, name, features, agents }: IntegrationConfig) {
  const availableFeatures = featureConfig.map((f) => f.id);

  for (const feature of features) {
    if (!availableFeatures.includes(feature)) {
      throw new Error(`Feature ${feature} not found`);
    }
  }

  integrations.push({
    id,
    name,
    features,
    agents,
  });
}

configureIntegration({
  id: "starter",
  name: "Starter",
  features: ["agentic_chat"],
  agents: async (features) => {
    return {
      agentic_chat: new StarterAgent(),
    };
  },
});
