# Changelog

## 0.0.44 — 2026-10-01

- Non-image attachments (PDF, audio, video) now sent as their own media block instead of `image_url`, preventing provider MIME rejections.
- TypeScript adapter emits native LangChain.js `source_type` media blocks instead of Python-style field names.
- Preserves image/video filenames through native conversion so reopened threads keep names.
- Normalizes audio MIME spellings so real MP3 attachments reach the model.
- Derives real file extensions for nameless attachments; `@langchain/openai` requires a usable filename.
- Treats `data:` URLs as inline data rather than remote references.
- Preserves plain string entries in multimodal content conversion.
- Fixes tool calls that start on the chunk ending streamed text being dropped.
- Preserves tool-call arguments across streamed tool boundaries.
- Accepts both Python and JavaScript chunk types and every provider finish reason in messages-tuple mode, fixing missing output.
- `connectAgent` can now read a thread with pending interrupts without rejecting.
- Surfaces provider failures as terminal run errors.
- Delivers a stop that races run stream startup; clones no longer inherit a pending stop.
- No longer re-emits `TOOL_CALL_START` on HITL resume.
- Malformed content items are dropped with a warning instead of aborting conversion.
- Media types looked up by own property only, preventing prototype-key injection.
- Added LangGraph raw event emission toggle.
- Validates outbound source payloads before emitting; empty/whitespace values rejected.

### Breaking changes

- Non-image attachments now emit dedicated media blocks instead of `image_url`; verify downstream consumers handle the new block shapes.
- TypeScript adapter emits `source_type`/`data`/`url` native blocks rather than Python `base64`/`mime_type`/`filename` fields.
- Media items with empty, null, numeric, or whitespace-only values are now dropped or rejected (tightened validation).
- `data:` URLs are classified as inline data, changing how they are stored and re-sent.
- Empty MIME type treated as absent; previously present-but-empty values are no longer used.
- Provider failures now surface as terminal run errors.
