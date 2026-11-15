# @ag-ui/a2ui-toolkit

Framework-agnostic helpers for building A2UI subagent tools.

Each per-framework adapter (LangGraph, ADK, Mastra, …) composes these helpers
with its own framework-specific glue: tool decorator, runtime accessor, model
binding + invoke. Nothing in this package depends on any agent framework.

## Surface

- Constants: `A2UI_OPERATIONS_KEY`, `BASIC_CATALOG_ID`, `DEFAULT_SURFACE_ID`,
  `GENERATE_A2UI_TOOL_NAME`, `GENERATE_A2UI_TOOL_DESCRIPTION`,
  `GENERATE_A2UI_ARG_DESCRIPTIONS`
- Op builders: `createSurface`, `updateComponents`, `updateDataModel`
- `RENDER_A2UI_TOOL_DEF` — JSON schema for the inner structured-output tool
- State + history helpers: `buildContextPrompt`, `findPriorSurface`
- Prompt composer: `buildSubagentPrompt`
- High-level orchestration: `prepareA2UIRequest`, `buildA2UIEnvelope`
- Output wrappers: `assembleOps`, `wrapAsOperationsEnvelope`, `wrapErrorEnvelope`

## Custom tool names and middleware association

Custom generation-wrapper `toolName` values continue to work with the middleware's
default nesting behavior. If you opt into `a2uiGenerationToolNames` to distinguish
sibling calls with distinct message IDs, include all your wrapper names. See the
[middleware configuration guide](../../../../middlewares/a2ui-middleware/README.md#optional-sibling-call-disambiguation)
for examples and ancestry limitations.

## See also

The Python counterpart lives in
[`ag-ui-a2ui-toolkit`](../../../python/a2ui_toolkit) and exposes the same
surface in snake_case.
