import { AbstractAgent } from "@ag-ui/client";

export interface IntegrationConfig {
  id: string;
  name: string;
  features: string[];
  agents: (features: string[]) => Promise<Record<string, AbstractAgent>>;
}
