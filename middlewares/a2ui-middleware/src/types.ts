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
 * A2UI component schema definition.
 * Declares which components are available, their props, and slots.
 * This is the contract between the application and the AI agent —
 * the agent can only generate UI using components defined here.
 */
export interface A2UIComponentSchema {
  /** Component name (e.g. "TodoCard", "FlightResult") */
  name: string;
  /** Human-readable description for the AI agent */
  description?: string;
  /** Component props as JSON Schema */
  props?: Record<string, unknown>;
  /** Named slots for child components */
  slots?: string[];
}

/**
 * Configuration for the A2UI Middleware
 */
export interface A2UIMiddlewareConfig {
  /**
   * Component schema — declares which components are available to agents.
   * When provided, the schema is injected as context into RunAgentInput
   * so agents know what components they can generate.
   */
  schema?: A2UIComponentSchema[];

  /**
   * Controls whether the middleware injects an A2UI rendering tool into
   * the agent's tool list.
   *
   * - `true` — injects a tool named `"render_a2ui"` (default name).
   * - `string` — injects the tool with the given custom name.
   * - `false` / omitted — no tool is injected; the middleware relies on
   *   the agent producing A2UI JSON through its own means and will still
   *   detect and render any valid A2UI JSON in the event stream.
   */
  injectA2UITool?: boolean | string;

  /**
   * Tool names the middleware recognizes as A2UI rendering tools.
   * When the middleware sees a TOOL_CALL_START for any of these names,
   * it tracks streaming args to progressively extract components/items
   * and emits a synthetic TOOL_CALL_RESULT at RUN_FINISHED.
   *
   * Defaults to `["render_a2ui"]`.
   */
  a2uiToolNames?: string[];

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

