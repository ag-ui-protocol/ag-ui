import type { Tool } from "@ag-ui/client";
import { jsonSchema, tool, type ToolSet } from "ai";

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

/**
 * Turns the tools the client runs (`RunAgentInput.tools`) into an AI SDK
 * `ToolSet`.
 *
 * The tools have no `execute`: when the model calls one, `streamText` emits
 * the call and stops. The run ends, the client runs the tool, and the next
 * run carries its result. Spread your own server tools after these so a
 * server tool wins a name clash:
 *
 * ```ts
 * tools: { ...toClientTools(input.tools), get_weather }
 * ```
 */
export function toClientTools(tools: Tool[] | undefined): ToolSet {
  const set: ToolSet = {};
  for (const clientTool of tools ?? []) {
    set[clientTool.name] = tool({
      description: clientTool.description,
      inputSchema: jsonSchema(toObjectSchema(clientTool.parameters)),
    });
  }
  return set;
}

/** Providers require tool parameters to be a JSON Schema object. */
function toObjectSchema(parameters: unknown): Parameters<typeof jsonSchema>[0] {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    return { ...EMPTY_OBJECT_SCHEMA };
  }
  const schema = parameters as Record<string, unknown>;
  if (schema.type === undefined && schema.properties === undefined) {
    return { ...EMPTY_OBJECT_SCHEMA };
  }
  return schema as Parameters<typeof jsonSchema>[0];
}
