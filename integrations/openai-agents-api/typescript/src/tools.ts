import type { Tool } from "@ag-ui/core";
import type { AgentToolParam, BackendTool } from "./types";

type FunctionToolParam = Extract<AgentToolParam, { type: "function" }>;

const objectSchema = (parameters: unknown): Record<string, unknown> => {
  if (
    parameters &&
    typeof parameters === "object" &&
    !Array.isArray(parameters)
  ) {
    const schema = parameters as Record<string, unknown>;
    if (schema.type === "object") return { properties: {}, ...schema };
  }
  return { type: "object", properties: {} };
};

export const functionTool = (
  tool: Pick<Tool | BackendTool, "name" | "description" | "parameters">,
): FunctionToolParam => ({
  type: "function",
  name: tool.name,
  description: tool.description || tool.name,
  parameters: objectSchema(tool.parameters),
});

/**
 * The full tool list for a session: the configured (built-in) tools, then the
 * backend tools, then the client's frontend tools. A backend tool shadows a
 * frontend tool of the same name, and either shadows a configured function.
 */
export const mergeTools = (
  configured: AgentToolParam[] | undefined,
  backendTools: BackendTool[],
  frontendTools: Tool[],
): AgentToolParam[] => {
  const functions = new Map<string, FunctionToolParam>();
  for (const tool of frontendTools)
    functions.set(tool.name, functionTool(tool));
  for (const tool of backendTools) functions.set(tool.name, functionTool(tool));
  const kept = (configured ?? []).filter(
    (tool) => tool.type !== "function" || !functions.has(tool.name),
  );
  return [...kept, ...functions.values()];
};

/** Stable fingerprint of a tool list, to tell when the session needs an update. */
export const fingerprintTools = (tools: AgentToolParam[]): string =>
  JSON.stringify(sortKeys(tools));

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/** Function call arguments arrive parsed; tolerate a JSON string too. */
export const parseArguments = (args: unknown): Record<string, unknown> => {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
};
