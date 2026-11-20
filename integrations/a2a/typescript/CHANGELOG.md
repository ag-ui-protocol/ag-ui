# Changelog

## 0.0.7 — 2026-10-13

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Image, audio, video and document parts are sent as A2A file parts (inline data as bytes, URLs as URIs) instead of raw data parts. A provider file handle has no A2A form and is dropped with a warning.
- `clone()` keeps the base agent's state and no longer wraps the shared A2A client again on every clone.
- Multimodal user messages and the package's MIT license file, both unreleased since 0.0.6.

### Breaking changes

None.
