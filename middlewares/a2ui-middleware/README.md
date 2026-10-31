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
