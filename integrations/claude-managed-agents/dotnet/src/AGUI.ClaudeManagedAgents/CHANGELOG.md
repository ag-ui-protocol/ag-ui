# Changelog

## 0.0.4 — 2026-10-21

- Child result delivery now persists across initial runs and reloads.
- Runtime context is forwarded across adapters.
- Canonical child results are recovered after approval.
- Text attachments are sent as UTF-8 text sources.
- Empty frontend results are now supported.

### Breaking changes

None.

## 0.0.3 — 2026-10-15

- Preserve multipart text separators when assembling message content.
- Skip unsupported message parts without abandoning tool calls.
- Preserve managed recovery across stream handoff and cancellation.
- Keep tool results separate from agent state.
- Recover managed agent sessions and pending approvals.
- Preserve live conversation content during streaming.

### Breaking changes

None.

## 0.0.2 — 2026-10-12

- Builds on the AG-UI .NET SDK 1.0.1. `RUN_STARTED` declares `ProtocolVersion`.
- Non-text parts dropped from user messages or flattened from tool results are logged as warnings, including media-only user messages that previously ended silently with `empty_run`.

### Breaking changes

None.
