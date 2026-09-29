# Changelog

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
