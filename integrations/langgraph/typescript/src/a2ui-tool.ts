/**
 * A2UI subagent tool factory for LangGraph TS agents.
 *
 * Thin adapter over ``@ag-ui/a2ui-toolkit`` — the heavy lifting (op builders,
 * prompt assembly, history walkers, output envelope) lives in the toolkit so
 * each new framework adapter (ADK, Mastra, Strands, …) only owns the
 * framework-specific glue: tool decorator, runtime state access, model
 * binding + invoke.
 *
 * Example usage in a chat node:
 *
 *   import { getA2UITools } from "@ag-ui/langgraph";
 *
 *   const a2ui = getA2UITools(new ChatOpenAI({ model: "gpt-4o" }));
 *
 *   const modelWithTools = chatModel.bindTools(
 *     [...state.tools, a2ui],
 *     { parallel_tool_calls: false },
 *   );
 */

import { tool, type ToolRuntime } from "@langchain/core/tools";
import { SystemMessage } from "@langchain/core/messages";
import {
  A2UI_OPERATIONS_KEY,
  BASIC_CATALOG_ID,
  DEFAULT_SURFACE_ID,
  GENERATE_A2UI_TOOL_NAME,
  GENERATE_A2UI_TOOL_DESCRIPTION,
  GENERATE_A2UI_ARG_DESCRIPTIONS,
  RENDER_A2UI_TOOL_DEF,
  buildA2UIEnvelope,
  prepareA2UIRequest,
  wrapErrorEnvelope,
  runA2UIGenerationWithRecovery,
  type A2UIRecoveryConfig,
  type A2UIValidationCatalog,
  type A2UIAttemptRecord,
} from "@ag-ui/a2ui-toolkit";

/**
 * Loose type for the subagent model.
 *
 * Typed as `any` (rather than `BaseChatModel`) to tolerate `@langchain/core` version
 * skew between this package and the consumer — e.g. `ChatOpenAI` shipping its own
 * peer-pinned core. The factory only needs `bindTools` + `invoke`, which is checked
 * at runtime.
 */
export type A2UISubagentModel = any;

// Re-export the toolkit constants for callers that previously imported them
// from this package — keeps the public surface stable.
export { A2UI_OPERATIONS_KEY, BASIC_CATALOG_ID };

export interface A2UISubagentToolOptions {
  /** Optional extra rules appended to the subagent's system prompt. */
  compositionGuide?: string;
  /** Surface id used when the subagent omits `surfaceId`. */
  defaultSurfaceId?: string;
  /** Catalog id assigned to every new surface this factory creates — the
   *  subagent never picks the catalog. Falls back to the basic v0.9 catalog. */
  defaultCatalogId?: string;
  /** Name advertised to the main agent's planner. */
  toolName?: string;
  /** Description shown to the main agent's planner. */
  toolDescription?: string;
  /**
   * Inline catalog (component name → JSON Schema with `required`) enabling
   * catalog-aware recovery (unknown-component / missing-required-prop). Pass the
   * SAME catalog the host gives `@ag-ui/a2ui-middleware` so the retry decision
   * (here) and the paint gate (middleware) agree. Omit for structural-only
   * recovery (malformed JSON, missing root, broken refs/bindings).
   */
  catalog?: A2UIValidationCatalog;
  /** Recovery loop config: attempt cap, retry-UI threshold, debug exposure. */
  recovery?: A2UIRecoveryConfig;
  /** Per-attempt hook for emitting recovery status / dev logs (non-disruptive). */
  onA2UIAttempt?: (record: A2UIAttemptRecord) => void;
}

/** Tool arguments exposed to the main agent's planner. */
interface GenerateA2UIArgs {
  /**
   * `"create"` to render a new surface, `"update"` to modify a surface
   * previously rendered in this conversation. Defaults to `"create"`.
   */
  intent?: "create" | "update";
  /**
   * Required when `intent="update"`. The surface id of the prior render
   * to modify.
   */
  target_surface_id?: string;
  /** Optional natural-language description of the changes to apply on update. */
  changes?: string;
}

/**
 * Build a LangGraph tool that delegates A2UI surface generation to a subagent.
 *
 * The returned tool is ready to bind into a chat model alongside any other tools.
 *
 * @param model Chat model the subagent will invoke for structured A2UI output.
 *   Using the same provider/model as the main agent is fine.
 * @param options Optional behavior overrides.
 */
export function getA2UITools(
  model: A2UISubagentModel,
  options: A2UISubagentToolOptions = {},
) {
  // Use `||` rather than destructuring defaults so empty-string overrides fall
  // back to the canonical defaults (matches the Python adapter, which uses
  // `or` for the same parity). Otherwise an accidental `""` from a caller
  // would advertise a nameless / empty-description tool to the planner.
  const {
    compositionGuide,
    defaultSurfaceId: defaultSurfaceIdOpt,
    defaultCatalogId: defaultCatalogIdOpt,
    toolName: toolNameOpt,
    toolDescription: toolDescriptionOpt,
    catalog,
    recovery,
    onA2UIAttempt,
  } = options;
  const defaultSurfaceId = defaultSurfaceIdOpt || DEFAULT_SURFACE_ID;
  const defaultCatalogId = defaultCatalogIdOpt || BASIC_CATALOG_ID;
  const toolName = toolNameOpt || GENERATE_A2UI_TOOL_NAME;
  const toolDescription = toolDescriptionOpt || GENERATE_A2UI_TOOL_DESCRIPTION;

  return tool(
    async (
      input: GenerateA2UIArgs,
      runtime: ToolRuntime<Record<string, unknown>, unknown>,
    ): Promise<string> => {
      // Defensive: a custom state schema (or a non-graph invocation) may not
      // preseed `state`/`messages` — mirror the Python adapter's graceful
      // degrade (`state.get("messages", [])`) instead of throwing mid-tool.
      const state = (runtime.state ?? {}) as Record<string, unknown>;
      const allMessages = (state.messages as Array<any>) ?? [];
      // Strip current (unbalanced) tool call from history.
      const messages = allMessages.slice(0, -1);

      // Shared: decide create/update, find prior surface, build the prompt.
      const prep = prepareA2UIRequest({
        intent: input.intent,
        targetSurfaceId: input.target_surface_id,
        changes: input.changes,
        messages,
        state,
        compositionGuide,
      });
      if (prep.error) return wrapErrorEnvelope(prep.error);

      // Glue: bind the structured-output tool.
      if (!model.bindTools) {
        return wrapErrorEnvelope("Provided model does not support bindTools");
      }
      const modelWithTool = model.bindTools([RENDER_A2UI_TOOL_DEF], {
        tool_choice: { type: "function", function: { name: "render_a2ui" } },
      });

      // Shared: validate→retry loop. On each retry the prompt is re-augmented
      // with the prior attempt's structured errors; only a validated surface is
      // committed (the middleware gate suppresses any unvalidated attempt, so a
      // rejected attempt never paints). Returns a structured hard-failure
      // envelope once the attempt cap is hit.
      const { envelope } = await runA2UIGenerationWithRecovery({
        basePrompt: prep.prompt,
        catalog,
        config: recovery,
        onAttempt: onA2UIAttempt,
        invokeSubagent: async (prompt) => {
          const response: any = await modelWithTool.invoke([
            new SystemMessage(prompt),
            ...messages,
          ] as any);
          const toolCalls: Array<{ args?: Record<string, unknown> }> =
            response.tool_calls ?? [];
          return toolCalls.length ? (toolCalls[0].args ?? {}) : null;
        },
        buildEnvelope: (args) =>
          buildA2UIEnvelope({
            args,
            isUpdate: prep.isUpdate,
            targetSurfaceId: input.target_surface_id,
            prior: prep.prior,
            defaultSurfaceId,
            defaultCatalogId,
          }),
      });
      return envelope;
    },
    {
      name: toolName,
      description: toolDescription,
      schema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            enum: ["create", "update"],
            description: GENERATE_A2UI_ARG_DESCRIPTIONS.intent,
          },
          target_surface_id: {
            type: "string",
            description: GENERATE_A2UI_ARG_DESCRIPTIONS.target_surface_id,
          },
          changes: {
            type: "string",
            description: GENERATE_A2UI_ARG_DESCRIPTIONS.changes,
          },
        },
      } as any,
    },
  );
}
