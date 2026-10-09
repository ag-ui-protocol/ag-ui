# Changelog

## 0.0.45 — 2026-10-05

- Non-streamed tool calls now attach to their owning assistant message, recorded at OnChatModelEnd, so clients no longer hang calls on unrecognized stand-in messages.
- Image and video filenames are preserved through native conversion; reopened threads retain names like sample.png.
- Fixed loss of tool calls emitted after streamed text in the same assistant message (e.g. Anthropic tool_use after text).
- messages-tuple mode now accepts the real AIMessageChunk wire type; previously every tuple was discarded, producing no output.
- Chunk type and finish-reason checks now accept both Python and JavaScript runtime vocabularies and all provider stop markers.
- connectAgent can now read a thread with pending interrupts; a second connect or reload no longer fails before transport start.
- Provider failures now surface as terminal run errors.
- Stop pressed at the start of a run is now delivered instead of leaving the run executing server-side.
- Clones no longer inherit a pending stop that would self-cancel the first run.
- Cancel retry is now gated on known server run id, avoiding cancels addressed to unknown client-generated ids.
- Tool call arguments are preserved across streamed tool boundaries.
- Plain string entries in list-form multimodal content are preserved instead of dropped.
- Non-image media types preserved across runtimes; Gemini video compatibility retained.
- Subgraph and root state snapshot ordering and caching fixes prevent stale STATE_SNAPSHOT emissions.
- Whitespace-only image_url values (e.g. "   ") are now rejected alongside empty strings.

### Breaking changes

- Validation tightened: whitespace-only image_url payloads are now rejected as malformed input.
- Follows @ag-ui/core/schemas 1.0 part renames and content flattening; re-verify multimodal and tool-result handling.
- Dropped file sources now emit a warning instead of sending a provider handle.

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
