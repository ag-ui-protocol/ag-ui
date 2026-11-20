/**
 * Tool conversion for the OpenAI Agents JS adapter.
 *
 * AG-UI tools are *frontend* tools: the model calls them, the adapter emits
 * `TOOL_CALL_*` events, halts the run with an `interrupt` outcome, and the
 * *frontend* executes them and returns the result in a subsequent run (fed
 * back to the SDK as a `function_call_result` input item). The adapter
 * therefore never executes frontend tools server-side.
 *
 * The SDK `FunctionTool`s created here carry a stub `execute` that returns a
 * placeholder. In the normal Phase 5 HITL flow the adapter halts on
 * `tool_called` *before* the stub runs, so the stub is never invoked — it
 * exists purely as a safety net so a single run doesn't hang if a tool is
 * somehow executed server-side (e.g. a non-frontend/backend tool, or a caller
 * that consumes the adapter without the halt path).
 *
 * State management mirrors the claude-agent-sdk pattern: an injected
 * `ag_ui_update_state` function tool the model calls to mutate the shared
 * state. The adapter intercepts that call (Phase 4) and emits a
 * `STATE_SNAPSHOT`; the stub `execute` here is a fallback that should never
 * run once interception is wired.
 */

import { STATE_MANAGEMENT_TOOL_NAME } from "./config";
import { hasState } from "./state";

/**
 * The minimal SDK surface `tools.ts` needs. `tool` is the SDK factory that
 * produces a `FunctionTool`; `Tool` is the union the `Agent` constructor
 * accepts. Kept loose (`unknown`) so this file doesn't import the SDK runtime
 * (it is only a peer dep) — the adapter passes the real module in.
 */
export interface ToolModule {
  tool: (options: Record<string, unknown>) => unknown;
}

/**
 * A JSON-schema object in the shape the OpenAI Agents JS SDK expects for
 * non-strict (`strict: false`) function tools: `JsonObjectSchemaNonStrict`.
 * The SDK requires `type: "object"`, `properties`, `required`, and
 * `additionalProperties: true` (non-strict always allows extra props).
 */
export interface NormalizedJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: true;
  description?: string;
}

/**
 * Normalise an AG-UI tool's `parameters` (an arbitrary JSON Schema, or
 * `undefined`) into the SDK's non-strict `JsonObjectSchemaNonStrict` shape.
 *
 * The AG-UI `Tool.parameters` field is `z.any()` — callers may pass a full
 * JSON Schema (`{ type: "object", properties, required }`) or a partial one.
 * We coerce to the SDK's required shape, defaulting `properties` to `{}` and
 * `required` to `[]` when absent. `additionalProperties` is always `true`
 * (non-strict mode).
 */
export function normalizeParameters(
  params: unknown,
): NormalizedJsonSchema {
  const p =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  const schema: NormalizedJsonSchema = {
    type: "object",
    properties: (p.properties as Record<string, unknown> | undefined) ?? {},
    required: Array.isArray(p.required)
      ? (p.required as unknown[]).filter(
          (k): k is string => typeof k === "string",
        )
      : [],
    additionalProperties: true,
  };

  if (typeof p.description === "string") {
    schema.description = p.description;
  }
  return schema;
}

/**
 * Convert a single AG-UI `Tool` into an OpenAI Agents JS `FunctionTool`.
 *
 * The tool is created in non-strict mode (`strict: false`) with the AG-UI
 * JSON Schema passed through (normalised to the SDK's expected shape). The
 * `execute` stub returns a placeholder string — actual execution happens on
 * the frontend (see file header).
 */
export function convertAguiToolToOpenAi(
  toolDef: { name?: string; description?: string; parameters?: unknown },
  mod: ToolModule,
): unknown {
  const name = toolDef.name ?? "tool";
  const description = toolDef.description ?? "";
  const parameters = normalizeParameters(toolDef.parameters);

  return mod.tool({
    name,
    description,
    parameters,
    strict: false,
    execute: async () => STUB_TOOL_RESULT,
  });
}

/**
 * Build the `ag_ui_update_state` function tool.
 *
 * The model calls this with the updated state; the adapter intercepts the
 * call (Phase 4) and emits `STATE_SNAPSHOT`. The `execute` stub is a fallback
 * that returns once the run is no longer intercepted.
 *
 * State-merge semantics: **replace** — the model passes the complete updated
 * state object in the `state` field. (Matches the claude-agent-sdk tool
 * description "Pass the complete updated state object." Test V3 pins replace
 * vs. patch.)
 */
export function createStateManagementTool(mod: ToolModule): unknown {
  return mod.tool({
    name: STATE_MANAGEMENT_TOOL_NAME,
    description:
      "Update the shared application state. Pass the complete updated state object. " +
      "Use this to persist changes that should be visible in the UI.",
    parameters: {
      type: "object",
      properties: {
        state: {
          type: "object",
          description: "The complete updated state object.",
          properties: {},
          required: [],
          additionalProperties: true,
        },
      },
      required: ["state"],
      additionalProperties: true,
    } as NormalizedJsonSchema,
    strict: false,
    execute: async () => STUB_TOOL_RESULT,
  });
}

/**
 * Assemble the full tool list for an agent run: the frontend tools from
 * `input.tools` (when any are provided) plus the `ag_ui_update_state` state
 * tool (when `input.state` is meaningful). Returns the SDK `FunctionTool[]`.
 *
 * Mirrors the claude-agent-sdk injection logic: state tool is added only when
 * the run carries state, so stateless runs don't expose a pointless tool.
 */
export function buildTools(
  input: { tools?: unknown[]; state?: unknown },
  mod: ToolModule,
): unknown[] {
  const tools: unknown[] = [];

  const inputTools = Array.isArray(input.tools) ? input.tools : [];
  for (const def of inputTools) {
    if (def && typeof def === "object") {
      tools.push(convertAguiToolToOpenAi(def as Record<string, unknown>, mod));
    }
  }

  if (hasState(input.state)) {
    tools.push(createStateManagementTool(mod));
  }

  return tools;
}

/** Placeholder result returned by stub `execute` functions. */
export const STUB_TOOL_RESULT = "Tool call forwarded to the frontend.";
