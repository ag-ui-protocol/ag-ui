import { configureIntegration } from "./types/integration";
import { StarterAgent } from "@ag-ui/starter";
export const integrations = [
  configureIntegration({
    id: "starter",
    name: "Starter",
    features: ["agentic_chat"],
    agents: async () => {
      return {
        agentic_chat: new StarterAgent(),
      };
    },
  }),
];
