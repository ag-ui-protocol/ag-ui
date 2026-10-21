# Changelog

## 0.2.2 — 2026-10-21

- Persist child result delivery across initial runs and reloads.
- Forward runtime context across adapters.
- Recover canonical child results after approval.
- Send text attachments as UTF-8 text sources.
- Send empty frontend completions as `content: []`, removing only zero-length text parts while retaining nonempty text, errors, and supported media.
- Updated example to a model that supports system injection.

### Breaking changes

- Empty frontend completions now serialize as `content: []` with zero-length text parts stripped; verify handling of empty tool results and continuation/replay.

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
