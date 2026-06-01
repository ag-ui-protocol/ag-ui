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
      const state = runtime.state as Record<string, unknown>;
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

      // Glue: bind the structured-output tool and invoke the subagent.
      if (!model.bindTools) {
        return wrapErrorEnvelope("Provided model does not support bindTools");
      }
      const modelWithTool = model.bindTools([RENDER_A2UI_TOOL_DEF], {
        tool_choice: { type: "function", function: { name: "render_a2ui" } },
      });
      const response: any = await modelWithTool.invoke([
        new SystemMessage(prep.prompt),
        ...messages,
      ] as any);

      const toolCalls: Array<{ args?: Record<string, unknown> }> =
        response.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return wrapErrorEnvelope("LLM did not call render_a2ui");
      }

      // Shared: assemble the final operations envelope.
      return buildA2UIEnvelope({
        args: toolCalls[0].args ?? {},
        isUpdate: prep.isUpdate,
        targetSurfaceId: input.target_surface_id,
        prior: prep.prior,
        defaultSurfaceId,
        defaultCatalogId,
      });
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
