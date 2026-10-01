# Changelog

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
