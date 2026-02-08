/**
 * Configuration for the A2UI Middleware
 */
export interface A2UIMiddlewareConfig {
  /**
   * If true, middleware assumes the system prompt already contains
   * the A2UI schema between ---BEGIN A2UI JSON SCHEMA--- and
   * ---END A2UI JSON SCHEMA--- markers.
   *
   * If false/undefined, logs a warning with the required schema
   * instructions to add to the system prompt.
   */
  systemInstructionsAdded?: boolean;
}

/**
 * User action payload sent via forwardedProps.a2uiAction
 */
export interface A2UIUserAction {
  /** Name of the action being performed */
  name?: string;

  /** ID of the surface the action occurred on */
  surfaceId?: string;

  /** ID of the component within the surface */
  sourceComponentId?: string;

  /** Optional context data for the action */
  context?: Record<string, unknown>;

  /** Optional timestamp of the action */
  timestamp?: string;
}

/**
 * Expected structure of forwardedProps for A2UI actions
 */
export interface A2UIForwardedProps {
  a2uiAction?: {
    userAction: A2UIUserAction;
  };
}

/**
 * A2UI message types (v0.9)
 */
export type A2UIMessageType = "createSurface" | "updateComponents" | "updateDataModel" | "deleteSurface";

/**
 * A2UI message structure (v0.9)
 */
export interface A2UIMessage {
  createSurface?: {
    surfaceId: string;
    catalogId: string;
    theme?: Record<string, unknown>;
    attachDataModel?: boolean;
  };
  updateComponents?: {
    surfaceId: string;
    components: Array<Record<string, unknown>>;
  };
  updateDataModel?: {
    surfaceId: string;
    path?: string;
    value?: unknown;
  };
  deleteSurface?: {
    surfaceId: string;
  };
}

