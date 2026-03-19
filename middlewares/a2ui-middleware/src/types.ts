/**
 * A2UI surface configuration: the component tree and data binding (v0.9).
 */
export interface A2UISurfaceConfig {
  /** Unique surface ID */
  surfaceId: string;
  /** Catalog ID for the v0.9 renderer */
  catalogId: string;
  /** The fixed component tree (v0.9 flat format) */
  components: Array<Record<string, unknown>>;
  /**
   * Which arg key contains the data to bind.
   * E.g. "flights" means the tool arg `{ flights: [...] }` is used for updateDataModel.
   */
  dataKey: string;
  /**
   * Pre-declared action handlers. When a button action is dispatched,
   * the renderer checks for an exact action name match, then "*" catch-all.
   * Same interface as a2ui.render(action_handlers={...}) in the Python SDK.
   */
  actionHandlers?: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Binds a tool to an A2UI surface. When the middleware sees a TOOL_CALL_START
 * for this tool, it emits the surface schema immediately. As the LLM streams
 * tool args, it partial-parses and emits dataModelUpdate progressively.
 */
export interface A2UIStreamingSurface {
  /** The tool name that triggers this surface */
  toolName: string;
  /** The A2UI surface to render */
  surface: A2UISurfaceConfig;
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
   * Surfaces that stream progressively when their tool is called.
   * Schema is emitted at TOOL_CALL_START, data streams as args are generated.
   */
  streamingSurfaces?: A2UIStreamingSurface[];
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

