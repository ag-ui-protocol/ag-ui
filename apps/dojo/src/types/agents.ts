import type { AbstractAgent } from "@ag-ui/client";
import type { FeatureFor, IntegrationId } from "./integration";

/**
 * Base type requiring all menu integrations with their specific features.
 */
export type MenuAgentsMap = {
  [K in IntegrationId]: () => Promise<{ [P in FeatureFor<K>]: AbstractAgent }>;
};

/**
 * Agent integrations map that requires all menu integrations but allows extras.
 * 
 * TypeScript enforces:
 * - All integration IDs from menu.ts must have an entry with correct features
 * - Additional unlisted integrations ARE allowed (for testing before public release)
 * 
 * The index signature allows extra keys without excess property checking errors.
 */
export type AgentsMap = MenuAgentsMap & {
  [key: string]: () => Promise<Record<string, AbstractAgent>>;
};
