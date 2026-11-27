# Changelog

## Unreleased

## 0.1.0 — 2026-11-27

- The packaged and Dojo FastAPI chat factories enable per-run guidance by default. Existing `LangGraphAgent` endpoints retain their current prompt handling. To enable run guidance on an existing LangChain chat graph, rebuild it with `RunGuidanceMiddleware` and serve it through an adapter with `RunGuidanceAgentMixin`. See [Run guidance for existing graphs](https://github.com/ag-ui-protocol/ag-ui/blob/82fd365149f9a8b696587bc0a597dba67f354e9b/integrations/langgraph/python/README.md#run-guidance-for-existing-graphs).
- Guidance can be opted out of, and snapshot echoes are scrubbed.
- Stale guidance is scrubbed from state snapshots.
- Preserves legacy message order and default checkpointing.
- Documentation added for run guidance, keyless listeners, and cross-host encryption.
- Run guidance behavior and state snapshot handling changed; verify guidance opt-out and snapshot contents after upgrade.

## 0.0.48 — 2026-11-21

- Continue-mode now starts a new run when forwarded input differs from what a prior node (e.g. permission gate) checked, preventing bypass of gating nodes.
- Continue no longer writes client state when it goes on, avoiding reducer channels (e.g. operator.add) double-combining values.
- Node name for continue is honored only when the thread actually ran that node last; client-supplied node_name can no longer skip graph nodes.
- Fixed resume logic under `durability="exit"` where one checkpoint per run made paused/gate nodes look already run.
- Continue-mode state writes now apply the input-schema filter, so clients cannot set channels outside the graph's input schema.
- Failed tool calls now stream TOOL_CALL_RESULT (and START/ARGS/END for non-streaming models) instead of only appearing in MESSAGES_SNAPSHOT.
- Pending tool failures are keyed by run plus tool_call_id, fixing lost/crossed results across concurrent graphs sharing an id.
- Interrupted tool calls (GraphInterrupt/GraphBubbleUp) are no longer recorded as failed.
- Error handlers returning a Command carrying an error ToolMessage now stream the result correctly.
- Tool messages are presented under their streamed id in MESSAGES_SNAPSHOT regardless of consumer timing; stopped mutating tool message objects in place.
- Tool messages without an id get a stable id so TOOL_CALL_RESULT matches the snapshot.
- Cancelled runs now synthesize a cancelled ToolMessage for dangling tool calls so the next turn is not rejected by the provider.
- `lg_interrupt_to_agui` reads `Interrupt.response_schema` first, falling back to value-level keys; non-mapping values ignored.
- Middleware-internal model calls (e.g. SummarizationMiddleware from langchain 1.4.0) no longer leak into the client stream as assistant text.
- RUN_STARTED declares `protocol_version` when the SDK provides PROTOCOL_VERSION, guarded for the 0.1.22 floor.
- A2UI recovery workers isolated and subagents kept on the caller event loop.
- Locked langgraph moves 1.2.8 -> 1.2.12.

### Breaking changes

- Continue with a changed input-schema value now starts a new run instead of resuming from the named node; thread flows relying on the old resume behavior must be re-verified.
- Client `forwardedProps.node_name` is honored only when the thread last ran that node; previously-accepted skips will now be rejected.
- Continue no longer writes client state when it goes on, and applies input-schema filtering; code depending on those writes or on setting out-of-schema channels must change.
- Tool message ids and TOOL_CALL_RESULT timing changed; id-based snapshot merges should be re-verified.
- Requires langgraph 1.2.12 for `Interrupt.response_schema`.

## 0.0.47 — 2026-10-07

- Non-streamed tool calls now name the owning assistant message as the parent instead of reusing the result message id.
- Image and video filenames are preserved through native conversion; filenames no longer lost when threads are stored and reopened.
- Provider failures now surface as terminal run errors; run errors documented.
- Non-image media types preserved across runtimes.
- `RUN_FINISHED.usage` / `RUN_ERROR.usage` now populated from provider metadata in Python (previously always absent).
- Model-end token usage recorded for non-streaming model calls, which previously reported no usage.
- Token counts capped at `Number.MAX_SAFE_INTEGER` rather than int64.
- Malformed `tool_call.arguments` JSON no longer crashes `agui_messages_to_langchain`.
- Plain string entries in list-form multimodal content are preserved instead of silently dropped.
- Reasoning content blocks guarded against non-mapping values that previously killed the stream.
- Whitespace-only and leading-whitespace `image_url` values now rejected like empty values.
- FastAPI endpoint helpers forward route kwargs (name, tags, summary, operation_id, dependencies, include_in_schema).
- Adapters follow 1.0 model part renames, flatten tool result content, and drop unsupported file sources with a warning.
- `CustomEventNames.Exit` documented as advisory-only; forwarded as `CUSTOM(name="exit")` and never terminates the stream.
- Removed unused `should_exit` flag.
- Command tool args now serialized safely.
- Changelog URLs added to published package metadata; `ag-ui-protocol` floor raised to `>=0.1.21`.

### Breaking changes

- Adapters now take validators from `@ag-ui/core/schemas` and follow the 1.0 model part renames; file sources that are provider handles are dropped with a warning rather than forwarded.
- `ag-ui-protocol>=0.1.21` is now required.
- Whitespace-only or leading-whitespace `image_url` payloads are now rejected (tightened validation).
- `CustomEventNames.Exit` is advisory and does not terminate the stream; verify if you relied on exit behavior.
- Tool-call parent ids changed for non-streamed calls; re-verify client assumptions about shared message ids.

## 0.0.46 — 2026-10-01

- Preserve image and video filenames through native conversion so reopened threads retain client-provided `metadata.filename`.
- Retain Gemini video compatibility by keeping video on `image_url` for that provider.
- Surface provider failures as terminal run errors instead of silent or uncaught failures.
- Preserve non-image media types across runtimes.
- Adopt the 1.0 models: validators now sourced from `@ag-ui/core/schemas`, with part renames, flattened tool result content, and dropped file sources emitted with a warning.
- No longer crash when `tool_call.arguments` contains malformed JSON; invalid arguments are handled gracefully.
- Added Changelog URL to published package metadata.

### Breaking changes

- Validators now come from `@ag-ui/core/schemas` and follow 1.0 part renames; re-verify message/part serialization against the new models.
- A part type dropped during conversion is named by its wire type, and file sources that cannot be sent are dropped with a warning rather than forwarded.
- Provider failures now terminate the run as errors; verify error-handling paths.

## 0.0.45 — 2026-09-09

- Endpoint helpers now forward FastAPI route kwargs (name, tags, summary, operation_id, dependencies, include_in_schema) so agent routes embed cleanly in existing APIs.
- Populate `RUN_FINISHED.usage` and `RUN_ERROR.usage` terminal-event token usage from provider metadata (previously always absent in Python).
- Record token usage from non-streaming model calls via `OnChatModelEnd`; streaming-disabled models previously reported no usage.
- Cap token counts at `Number.MAX_SAFE_INTEGER` (2**53 - 1) to match the TypeScript protobuf decoder.
- Preserve plain string entries in multimodal message content conversion, keeping their original order alongside structured blocks.
- Guard reasoning content blocks against non-mapping values; `AIMessageChunk(content=["hello"])` no longer raises and kills the stream.
- Reject whitespace-only or leading-whitespace `image_url` payloads that previously bypassed the empty-value guard.

### Breaking changes

- `image_url` payloads that are whitespace-only or have leading whitespace are now rejected; re-verify attachment inputs.
- Token counts are now capped at 2**53 - 1 rather than int64's 2**63 - 1.
