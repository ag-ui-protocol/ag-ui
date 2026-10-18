# Changelog

## 0.2.1 — 2026-10-15

- Preserve multipart text separators when assembling message content.
- Skip unsupported message parts without dropping associated tool calls.
- Maintain managed recovery state across stream handoff and cancellation.
- Keep tool results separate from agent state.
- Recover managed agent sessions and pending approvals.
- Preserve live conversation content during streaming.

### Breaking changes

None.

## 0.2.0 — 2026-10-12

- Requires AG-UI 1.0 (`ag-ui-protocol>=1.0.0`). `RUN_STARTED` declares `protocol_version`.
- File sources in tool results are skipped with a warning instead of being sent as URLs; dropped user media and audio/video parts are logged.
- The endpoint helper forwards FastAPI route kwargs (`name`, `tags`, `dependencies`, …).

### Breaking changes

None.
