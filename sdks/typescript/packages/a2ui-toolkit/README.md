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

## By-reference data (avoid paying output tokens to render server-held data)

When an agent already holds a dataset (e.g. rows a backend tool fetched in
milliseconds), the dynamic path would otherwise force the render subagent to
re-serialize every row into its `data` argument — a 1,000-row table can cost
~27K output tokens before anything paints. By-reference data lets the host
supply that data out-of-band so the subagent emits only the component structure
with path bindings, never the rows.

### The contract

`buildA2UIEnvelope`, `assembleOps`, `prepareA2UIRequest`, and
`runA2UIGenerationWithRecovery` all accept an optional `externalData`
(`Record<string, unknown>`). When present:

1. **Merge** — `externalData` is shallow-merged over the subagent's `args.data`
   at the surface data root, `externalData` winning per top-level key. The
   resulting `updateDataModel` is always emitted, even when the subagent omitted
   `data` entirely.
2. **Validate** — recovery resolves binding paths against the *merged* data, so
   a by-reference render does not false-positive `unresolved_binding` and retry.
3. **Prompt** — the subagent is given a compact outline of the data *shape*
   (top-level keys + one truncated sample per array, never the full rows) and is
   told to bind to those paths and omit `data`. This is what actually saves the
   tokens.

Absent `externalData`, every function behaves exactly as before.

### Sourcing it: two channels (resolved by `resolveExternalData`)

Adapters call `resolveExternalData({ a2uiData, dataRef, messages })`, which
returns the data from whichever channel is present (Channel A wins):

- **Channel A — `forwardedProps.a2ui_data`**: a caller-supplied data blob. The
  key is lowercase snake (`a2ui_data`) so it survives the LangGraph
  camel→snake `forwardedProps` conversion unchanged.
- **Channel B — `data_ref`**: a planner-supplied tool argument carrying the
  tool-call-id of a prior tool result whose content *is* the dataset (the rows a
  backend tool already returned). The id is cheap to pass; the rows never
  re-enter the LLM. Exposed to the planner as `GENERATE_A2UI_ARG_DESCRIPTIONS.data_ref`.

The toolkit merge is source-neutral; only the adapter's sourcing differs.

## See also

The Python counterpart lives in
[`ag-ui-a2ui-toolkit`](../../../python/a2ui_toolkit) and exposes the same
surface in snake_case.
