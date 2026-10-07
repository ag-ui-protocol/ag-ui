# Changelog

## Unreleased

- Delivers audio in user messages as a native `AudioBlock` with exact bytes, so clips reach the model and durable session history instead of being dropped. Needs `@strands-agents/sdk` 1.14.0+; older releases report the clip in `MediaDropped` with that requirement as the reason.
- Sends audio only when the new `audioInputSupported` config is `true`; omitted, audio stays disabled, since a provider class cannot tell whether the selected model accepts audio input. Refused clips are reported in `MediaDropped` as `configured model does not support audio input` and kept out of the seed, replayed history and session history; an audio-only message ends in `MEDIA_RESOLUTION_FAILED`.
- Keeps the client's original attachment filenames (`metadata.filename` or `metadata.fileName`) in native persistence: the user message records each named image, document, video and delivered audio block under `metadata.custom["ag-ui"].attachments`, which Strands writes into session snapshots and leaves out of provider requests. The model-visible document name stays neutral.

## 0.3.0 — 2026-09-11

- TypeScript bridge now forwards `RunAgentInput.context` to the model, matching the Python bridge.
- Adds provider token usage on `RUN_FINISHED`/`RUN_ERROR` terminal events, accumulated per (provider, model).
- Adds `templateToolsProvider`/`template_tools_provider` to filter template agent tools per request.
- Exposes URL fetch policy through TypeScript adapter config; validates URL sources (scheme allowlist, address checks, size cap, redirects) before fetching.
- Adds per-thread agent config route; reports uncarried settings per field.
- Surfaces model citations on the assistant message under a `citations` metadata key, including chunk mode.
- Reports abnormal model stop reasons and guardrail interventions as `RUN_ERROR` in TypeScript.
- Recovers frontend tool results across restart in TypeScript; carries `ToolMessage.error` onto tool results.
- Preserves multi-block and non-text tool results, attachments, and reports media drops.
- Fixes media conversion defects including URL attachments with no declared type.
- Python bridge gains multi-agent orchestrator support and per-thread concurrent-run refusal (`THREAD_BUSY`).
- Adds interrupt support with persistence across restarts; presence, not truthiness, decides answered interrupts.
- Emits RAW for unmapped stream events; forwards unrecognised delta kinds (including Bedrock citations) to RAW fallback.
- Advertises `events.RAW: true` in the TypeScript capabilities matrix.
- Unifies terminal error codes/messages and emitted events across both bridges.
- Carries newer Strands SDK config fields to per-thread agents instead of dropping them silently.
- Requests extended thinking on the Anthropic demo provider when reasoning is enabled.
- Contains hostile HTTP responses; blocks zero-net and NAT64-embedded URL targets; closes auth fail-open paths.

### Breaking changes

- CORS is now opt-in: `createStrandsApp` no longer installs CORS unconditionally or defaults `corsOrigin` to `"*"`. Re-verify cross-origin config.
- Empty `corsOrigin` array now denies all origins instead of collapsing to wildcard; credentials withheld for wildcard and `null` origins.
- Auth guard now runs before body parsing; verify auth-protected routes.
- Terminal `RUN_ERROR` codes and message text changed to unify across bridges; clients matching on code/message must re-verify.
- Citations now ride message metadata rather than only RAW; RAW capability now reported as true.
- Resume payload shape, cancellation sentinels, and approval metadata keys aligned across bridges; re-verify tool-result handling on resume.
- Newer SDK config fields require an explicit disposition; a new SDK field can fail the TypeScript build until mapped.
