/**
 * Pre-registered A2UI schema for a tool. When the middleware sees a
 * TOOL_CALL_START for a tool with a registered schema, it emits
 * surfaceUpdate + beginRendering immediately (before any args stream in).
 * As args stream in, it partial-parses and emits dataModelUpdate progressively.
 */
export interface A2UIToolSchema {
  /** Unique surface ID */
  surfaceId: string;
  /** Root component ID */
  root: string;
  /** The fixed component tree */
  components: Array<Record<string, unknown>>;
  /**
   * Which arg key contains the data to bind.
   * E.g. "flights" means the tool arg `{ flights: [...] }` is used for dataModelUpdate.
   */
  dataKey: string;
}

/**
 * Configuration for the A2UI Middleware
 */
export interface A2UIMiddlewareConfig {
  /**
   * If true, the middleware injects the `send_a2ui_json_to_client` tool
   * into the agent's tool list so the LLM can call it directly.
   *
   * If false (default), the middleware does not inject the tool and relies
   * on the agent producing A2UI JSON through its own means (e.g. backend
   * tools, hardcoded responses). The middleware will still detect and
   * render any valid A2UI JSON that appears in the event stream.
   */
  injectA2UITool?: boolean;

  /**
   * Pre-registered A2UI schemas keyed by tool name. When a tool call starts
   * for a registered tool, the middleware emits the schema immediately and
   * streams data updates as args are generated.
   */
  schemas?: Record<string, A2UIToolSchema>;
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

