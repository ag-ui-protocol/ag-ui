import type { AbstractAgent } from "@ag-ui/client";
import type { FeatureFor, IntegrationId } from "./integration";

/** Features that are UI-only and don't require a backend agent entry */
type UIOnlyFeature = "v1_agentic_chat";

/**
 * Base type requiring all menu integrations with their specific features.
 * UI-only features (like v1_agentic_chat) are excluded since they reuse
 * existing backend agents and only differ in the frontend rendering.
 */
export type MenuAgentsMap = {
  [K in IntegrationId]: () => Promise<{ [P in Exclude<FeatureFor<K>, UIOnlyFeature>]: AbstractAgent }>;
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
