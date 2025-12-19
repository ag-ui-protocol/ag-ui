import { type MenuIntegrationConfig, menuIntegrations } from "../menu";

/** Check if an integration ID is valid */
export function isIntegrationValid(integrationId: string): boolean {
  return menuIntegrations.some((i) => i.id === integrationId);
}

/** Check if a feature is available for a given integration */
export function isFeatureAvailable(integrationId: string, featureId: string): boolean {
  const integration = menuIntegrations.find((i) => i.id === integrationId);
  return (integration?.features as readonly string[])?.includes(featureId) ?? false;
}

/** Get integration config by ID */
export function getIntegration(integrationId: string): MenuIntegrationConfig | undefined {
  return menuIntegrations.find((i) => i.id === integrationId);
}
