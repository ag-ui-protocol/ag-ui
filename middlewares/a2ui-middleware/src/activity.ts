/** Browser-safe activity contract shared by producers and renderers. */
export const A2UIActivityType = "a2ui-surface";
export const A2UI_HISTORY_METADATA = "@ag-ui/a2ui-middleware";

/**
 * The container key used to wrap A2UI operations for explicit detection.
 * Must match the key used by copilotkit.a2ui.render() (Python SDK)
 * and A2UIMessageRenderer (React).
 */
export const A2UI_OPERATIONS_KEY = "a2ui_operations";

/**
 * Extract surfaceId from a single A2UI operation (v0.9 keys)
 */
export function getOperationSurfaceId(
  operation: Record<string, unknown>,
): string | undefined {
  // v0.9 message types
  const createSurface = operation.createSurface as
    | { surfaceId?: string }
    | undefined;
  const updateComponents = operation.updateComponents as
    | { surfaceId?: string }
    | undefined;
  const updateDataModel = operation.updateDataModel as
    | { surfaceId?: string }
    | undefined;
  const deleteSurface = operation.deleteSurface as
    | { surfaceId?: string }
    | undefined;

  return (
    createSurface?.surfaceId ??
    updateComponents?.surfaceId ??
    updateDataModel?.surfaceId ??
    deleteSurface?.surfaceId
  );
}
