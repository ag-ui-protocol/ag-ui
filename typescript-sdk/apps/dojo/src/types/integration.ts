import { AbstractAgent } from "@ag-ui/client";

export interface IntegrationConfig {
  id: string;
  name: string;
  features: {
    featureID: string;
    agent: AbstractAgent;
  }[];
}
