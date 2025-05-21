import { IntegrationConfig } from "./types/integration";
import { featureConfig } from "./config";
import { StarterAgent } from "@ag-ui/starter";
export const integrations: IntegrationConfig[] = [];

// A helper method to configure
function configureIntegration({ id, name, features }: IntegrationConfig) {
  const availableFeatures = featureConfig.map((f) => f.id);

  for (const feature of features) {
    if (!availableFeatures.includes(feature.featureID)) {
      throw new Error(`Feature ${feature.featureID} not found`);
    }
  }

  integrations.push({
    id,
    name,
    features,
  });
}

configureIntegration({
  id: "starter",
  name: "Starter",
  features: [{ featureID: "agentic_chat", agent: new StarterAgent() }],
});
