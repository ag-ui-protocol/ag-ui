# Changelog

## 1.0.0 — 2026-09-17

- Rebuilt on generated types; the main entry is now zod-free with validators moved to @ag-ui/core/schemas, making zod an optional peer.
- 0.x names remain as deprecated aliases of the same types (see DEPRECATIONS.md); content parts are named by what they are rather than by direction.
- PROTOCOL_VERSION now reads "1.0"
- Ships the AG-UI 1.0 specification, JSON Schema, and the generators SDKs are produced from.

### Breaking changes

- PROTOCOL_VERSION changed to "1.0".
- Validators moved to @ag-ui/core/schemas; zod is now an optional peer, so imports relying on zod from the main entry must update.
- Several 0.x type names are now deprecated aliases; re-verify against DEPRECATIONS.md.
