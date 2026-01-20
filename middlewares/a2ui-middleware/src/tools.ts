import { Tool } from "@ag-ui/client";

/**
 * Tool name for sending A2UI JSON to the client
 */
export const SEND_A2UI_TOOL_NAME = "send_a2ui_json_to_client";

/**
 * Tool name for logging A2UI events (synthetic, used for context)
 */
export const LOG_A2UI_EVENT_TOOL_NAME = "log_a2ui_event";

/**
 * Tool definition for sending A2UI JSON to the client.
 * This tool is injected into the agent's available tools.
 * Matches Google's A2UI tool definition.
 */
export const SEND_A2UI_JSON_TOOL: Tool = {
  name: SEND_A2UI_TOOL_NAME,
  description:
    "Sends A2UI JSON to the client to render rich UI for the user. " +
    "This tool can be called multiple times in the same call to render multiple UI surfaces. " +
    "Args: a2ui_json: Valid A2UI JSON Schema to send to the client. " +
    "The A2UI JSON Schema definition is between ---BEGIN A2UI JSON SCHEMA--- and ---END A2UI JSON SCHEMA--- in the system instructions.",
  parameters: {
    type: "object",
    properties: {
      a2ui_json: {
        type: "string",
        description: "Valid A2UI JSON Schema to send to the client.",
      },
    },
    required: ["a2ui_json"],
  },
};

