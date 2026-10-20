# Changelog

## 0.0.3 — 2026-10-15

- Preserve multipart text separators when assembling message content.
- Skip unsupported message parts without discarding associated tool calls.
- Maintain managed recovery state across stream handoff and cancellation.
- Keep tool results separate from agent state to avoid cross-contamination.
- Recover managed agent sessions and pending approvals after interruption.
- Preserve live conversation content during streaming.

### Breaking changes

None.

## 0.0.2 — 2026-10-12

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Dropped user media, including media-only user messages, and dropped audio/video tool-result parts are logged as warnings.

### Breaking changes

None.
