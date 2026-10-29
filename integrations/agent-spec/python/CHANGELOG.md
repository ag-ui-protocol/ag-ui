# Changelog

## 0.2.0 — 2026-10-12

- Requires AG-UI 1.0 (`ag-ui-protocol>=1.0.0`). `RUN_STARTED` declares `protocol_version`.
- Content-part arrays on user and tool messages are flattened to text; media and file-source parts are skipped with a warning. Developer messages map to system instructions, and activity and reasoning messages are ignored instead of raising.
- WayFlow flows get the last user message as input. A run without one fails with `RUN_ERROR` instead of an `IndexError`.
- The endpoint helper forwards FastAPI route kwargs (`name`, `tags`, `dependencies`, …).

### Breaking changes

None.
