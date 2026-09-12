# Changelog

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
