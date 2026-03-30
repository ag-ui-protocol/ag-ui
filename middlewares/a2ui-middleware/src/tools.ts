import { Tool } from "@ag-ui/client";

/**
 * Tool name for the structured render_a2ui tool
 */
export const RENDER_A2UI_TOOL_NAME = "render_a2ui";

/**
 * Tool name for logging A2UI events (synthetic, used for context)
 */
export const LOG_A2UI_EVENT_TOOL_NAME = "log_a2ui_event";

/**
 * Tool definition for rendering A2UI surfaces.
 * This tool is injected into the agent's available tools when injectA2UITool is true.
 * Uses structured parameters (surfaceId, catalogId, components, items)
 * instead of a raw JSON string.
 */
export const RENDER_A2UI_TOOL: Tool = {
  name: RENDER_A2UI_TOOL_NAME,
  description:
    "Render a dynamic A2UI v0.9 surface with structured parameters. " +
    "The A2UI JSON Schema definition is between ---BEGIN A2UI JSON SCHEMA--- and ---END A2UI JSON SCHEMA--- in the system instructions.",
  parameters: {
    type: "object",
    properties: {
      surfaceId: {
        type: "string",
        description: "Unique surface identifier.",
      },
      catalogId: {
        type: "string",
        description: "The catalog ID for the component catalog.",
      },
      components: {
        type: "array",
        description:
          "A2UI v0.9 component array (flat format). The root component must have id \"root\".",
        items: { type: "object" },
      },
      items: {
        type: "array",
        description: "Plain JSON array of data objects for data binding.",
        items: { type: "object" },
      },
    },
    required: ["surfaceId", "components"],
  },
};
