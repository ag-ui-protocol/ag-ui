# @ag-ui/a2ui-middleware

Middleware for streaming A2UI surfaces and generation recovery activities.

## Optional sibling-call disambiguation

Existing consumers need no configuration changes. By default, the middleware
preserves nested render ownership for all generation-wrapper names, including
custom names: retries and final success or failure replace one wrapper activity.

Some adapters give sibling tool calls distinct `parentMessageId` values. Message
IDs identify assistant messages, not parent tool calls, so these calls cannot be
distinguished reliably from nested renders. If your adapter does this, you can
opt into stricter association by listing your generation wrappers:

```ts
import { A2UIMiddleware } from "@ag-ui/a2ui-middleware";

const middleware = new A2UIMiddleware({
  a2uiGenerationToolNames: ["generate_a2ui", "create_dashboard"],
});
```

Include every outer generation wrapper used by your agent, including custom
adapter `toolName` values. These are not the inner render tools listed in
`a2uiToolNames`. With an explicit list, calls with distinct, nonempty message IDs
remain independent unless the preceding tool is a listed wrapper. This lets a
sibling dashboard render and a flight tool's result retain separate activities.
Use `a2uiGenerationToolNames: []` if your agent has no generation wrappers.

Omitting the option retains the legacy heuristic; an empty list opts into stricter
association with no known wrappers. When opting in, an omitted wrapper name can
cause its retries to get separate activities, leaving a failed attempt alongside
a successful render. There is no built-in wrapper list in this opt-in mode.

## Ancestry limitations

- Calls sharing a nonempty parent message ID remain siblings in either mode.
- Without the option, distinct-ID siblings can still be mistaken for nested
  calls and suppress valid output. This is the existing default behavior.
- Even with the option, distinct-ID siblings involving a listed wrapper such as
  `generate_a2ui` and a direct `render_a2ui` can still be combined incorrectly.
- Missing or empty message IDs retain heuristic nesting in either mode.
  Concurrent generation wrappers can also be associated with the most recent
  candidate rather than the actual parent.

Unambiguous automatic association requires adapters to provide parent-tool-call
ancestry or consistent sibling message identities. Neither tool arguments nor
`TOOL_CALL_END` (which ends argument streaming) reliably proves nesting.

### Automatic tool completion

When this middleware supplies a result for a render call made in the current run, it continues the downstream agent with that result and the original call ID. UI activity and results stay inside one public run. Other unresolved frontend calls, interruptions, cancellation, and errors stop continuation. New render chains are limited to ten rounds; exceeding that limit fails the stream. Historical calls are not executed again.

Failed middleware results carry `metadata["ag-ui:tool-result"].error`. The string marker (including an empty string) preserves error status through client history without changing the result payload. Claude SDK recovery reads this marker when no explicit tool-message `error` is present.

## Catalog protocol selection

The catalog the host registers decides which A2UI protocol the middleware
speaks. When the schema context entry (or a configured inline `schema`)
declares `protocolVersion: "1.0"`, the operations streamed for a nested
`render_a2ui` call carry `version: "1.0"` and the zero-config catalog fallback
is the 1.0 basic catalog. Without a declaration the middleware keeps emitting
`version: "v0.9"` exactly as before.

The streamed payload has to be written in the declared protocol. A 1.0 catalog
expects `{"@path": ...}` bindings and `{"@call": ...}` functions; a v0.9 catalog
expects `{"path": ...}` bindings. An attempt whose bindings contradict the
declaration is never painted (it reports a `protocol_mismatch` error on the
`retrying` state, like any other invalid attempt) so that the adapter's
recovery loop regenerates it. Protocol-neutral components paint under either
catalog. With `injectA2UITool`, the injected tool description and usage guide
are written for the declared protocol as well.

## Final results and painted activities

A tool result carrying `a2ui_operations` is resolved against what is already
painted for each of its surfaces in the same invocation — the middleware's own
streamed paint, or an activity the wrapped adapter emitted itself (the ADK
Express path paints a complete `a2ui-surface` activity before returning the
canonical envelope). A result that repeats the paint is dropped as redundant. A
result that differs is folded onto the retained activity: its `createSurface`
(catalog, version, metadata, `sendDataModel`, theme) stays even when the result
repeats a bare creation, the result's components and data replace the painted
ones, and a `deleteSurface` is applied after them. Each activity therefore replays on its own into a fresh renderer.
The canonical `TOOL_CALL_RESULT` is forwarded unchanged, and surfaces nothing
painted still paint as-is under their own call.
