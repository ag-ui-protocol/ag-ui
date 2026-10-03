# Changelog

## Unreleased

- Deliver user audio attachments as native Strands audio blocks, so they reach the model and persist in session history (file and snapshot sessions) byte for byte. Requires strands-agents 1.53.0+; on older SDKs the attachment is reported in `MediaDropped` with the reason `installed strands-agents does not support audio input (requires >= 1.53.0)`. Unsupported audio MIME types are reported as `unsupported media type`.
- Deliver audio only to a model whose Strands formatter carries it. By default that is `BedrockModel` and `LlamaCppModel`; any other model gets the attachment reported in `MediaDropped` with the reason `configured model does not support audio input`, before a URL source is fetched and before anything reaches session history, on the live turn and on replayed history alike. A text turn with a dropped clip still completes, and an audio-only turn ends with `MEDIA_RESOLUTION_FAILED` without saving a turn. Set `StrandsAgentConfig.audio_input_supported` to `True` for a custom model that handles audio, or `False` for a Bedrock model id without audio input.
- Count delivered audio in `MediaDropped.delivered`.
- Keep the client's original attachment filenames (`metadata.filename` or `metadata.fileName`) in native persistence: the user message records each named image, document, video and delivered audio block under `metadata.custom["ag-ui"]["attachments"]`, which Strands stores with the message and keeps out of provider requests. The model-visible document name stays neutral.

## 0.4.1 — 2026-09-23

- Reconcile frontend tool results into snapshot sessions: native `toolResult` is now updated instead of leaving a "Forwarded to client" placeholder and sending a synthetic user message.
- Recognize `SnapshotSessionManager` during reconciliation, in addition to repository-backed managers.
- Drop the pre-1.55 inner run-loop close that could save transient context, swallow save failures, and read a private SDK frame local; strands-agents 1.55+ recommended.
- Respect the manager's `save_latest_on` setting during snapshot reconciliation.
- Adopt @ag-ui/core/schemas validators and the 1.0 model part renames; flatten tool result content to text and drop file sources with a warning rather than forwarding a provider handle.

### Breaking changes

- Message part handling follows the 1.0 model: renamed parts, tool result content flattened to text, and file sources dropped with a warning instead of sending a provider handle.
- Below strands-agents 1.55 a halted turn's snapshot is saved late; 1.55+ recommended and some restart-dependent snapshot tests skip on older versions.

## 0.4.0 — 2026-09-11

- Report provider token usage on `RUN_FINISHED.usage` and `RUN_ERROR.usage`, accumulated per (provider, model); labels `OpenAIResponsesModel` as `openai`.
- Surface model citations on the annotated assistant message under a top-level `citations` metadata key; carried through chunk mode.
- Add `template_tools_provider`/`templateToolsProvider` to `StrandsAgentConfig` to filter template agent tools per request.
- Add per-thread agent config route; forward plugins per-thread; report uncarried settings per field; carry newer-SDK constructor fields.
- Drive multi-agent orchestrators (Graph/Swarm) from the Python bridge; `agent` now accepts a callable invoked per run for isolation.
- Delegate frontend waits to native interrupts by default; report the pause; make retries idempotent.
- Surface `RunAgentInput.context` to the model as a separate leading user message.
- Refuse a second concurrent run per thread with `RUN_ERROR { code: "THREAD_BUSY" }` on the Python single-agent path.
- Emit `RUN_ERROR CONTINUATION_TOOL_NAME_UNRESOLVED` when a continuation tool result cannot be named; fail closed instead of empty prompt.
- Emit `hook_error` CustomEvent when a developer callback throws.
- Validate URL sources before server-side fetch: restrict schemes to http/https, refuse redirect downgrades, prevent DNS rebinding, apply byte/timeout ceilings across redirect hops.
- Harden HTTP endpoints: strict JSON content-type validation, auth hook, CORS opt-out; apply dojo CORS allowlist to mounted demos.
- Preserve attachments, multi-block and non-text tool results; report media drops.
- Fix text/tool-call wire ordering so text is closed before a tool call opens.
- Read parked tool batch across Strands 1.54 and 1.55+ checkpoint shapes.
- Unify terminal error codes, message text, resume contract, and events across Python and TypeScript bridges.
- Emit RAW events for unmapped stream events; forward inner agent events; sanitize RAW payloads.
- Report force stops as run errors with the actual reason; emit error message on force_stop with no content.
- Exclude template-bound management tools from forwarding.

### Breaking changes

- CORS: an empty allow-list now denies all origins on the TypeScript side instead of defaulting to wildcard; choose an explicit policy.
- URL fetch now refuses schemes outside http/https at construction and enforces byte/timeout ceilings across redirect hops.
- Frontend waits now use native interrupts by default; absence of `ToolBehavior(continue_after_frontend_call=False)` no longer selects the legacy placeholder-and-halt path.
- Terminal `RUN_ERROR` codes and message text changed to a unified set; clients matching codes/messages literally must re-verify.
- Concurrent second run on one thread now rejected with `RUN_ERROR { code: "THREAD_BUSY" }` on the Python single-agent path.
- `RUN_FINISHED`/`RUN_ERROR` now carry `usage` and `outcome`; clients must tolerate these fields.
- Citations now ride assistant message metadata rather than only the RAW fallback.
- Content-type validation on HTTP endpoints is now strict JSON.
