# Changelog

## 0.2.0 — 2026-10-12

- Requires AG-UI 1.0 (`ag-ui-protocol>=1.0.0`). `RUN_STARTED` declares `protocol_version`.
- Audio and video parts are skipped with a warning; other multimodal input is preserved.
- Errored turns end with `RUN_ERROR` instead of `RUN_FINISHED`, without duplicate assistant messages.
- Tool calls on the non-streaming fallback path carry `parent_message_id` (#2118).
- Sessions survive input errors.
- The endpoint helper forwards FastAPI route kwargs (`name`, `tags`, `dependencies`, …).

### Breaking changes

None.
