# Changelog

## 1.0.0 — 2026-09-17

- Froze the draft schema as 1.0; `PROTOCOL_VERSION` now reads "1.0", and the schema `$id` moved to `/spec/1.0/schema.json`.
- `ag_ui.core` re-exports generated 1.0 models, with 0.x names kept as aliases.
- Added generated models for content parts, tool result parts, capabilities, run outcomes, token usage with cache writes, and file source.
- Optional null fields are now omitted on serialization; payload nulls are preserved.
- The single wire protocol version is now the generated `PROTOCOL_VERSION`.
- Added stable Changelog project URLs to published package metadata on PyPI.

### Breaking changes

- The wire protocol version changed to "1.0"; consumers comparing versions must re-verify.
- Model names changed to 1.0 names (0.x names remain as aliases); verify imports.
- The redundant `MetadataMixin` export was removed.
- Serialization now omits optional nulls, changing emitted payloads.
