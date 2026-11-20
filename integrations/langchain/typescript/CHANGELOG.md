# Changelog

## 0.0.4 — 2026-10-12

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Tool-result content parts are flattened to text; user image parts become LangChain `image_url` blocks. Parts with no LangChain equivalent are dropped with a warning.
- Streamed tool calls are no longer dropped in minified builds; messages are detected by their LangChain type tag instead of `constructor.name`.

### Breaking changes

None.
