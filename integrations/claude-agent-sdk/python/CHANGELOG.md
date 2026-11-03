# Changelog

## 0.2.3 — 2026-10-21

- Clear completed tool batches before later failures to avoid stale state.
- Persist deferred batches before interrupted streams so recovery works correctly.
- Retain and reject unsupported pending tool batches instead of leaving them unresolved.
- Complete SDK middleware tools and retain recovery input during recovery.
- Retain unresolved child tool identities across parallel tool calls.
- Preserve historical errors and results in metadata during approval recovery.

### Breaking changes

None.

## 0.2.2 — 2026-10-15

- Preserve split content and render qualified tool names.
- Recover default frontend tool calls and reconcile state snapshots.
- Preserve profile context and expire stale local bindings.
- Restore frontend tool results through a ready MCP transport.
- Use Python's native tool error flag when reporting tool failures.
- Preserve frontend result failure status instead of dropping it.
- Restore original sessions and support native deferred approvals.
- Retain native structured tool result envelopes and media diagnostics.
- Preserve rich results and canonical frontend payloads.

### Breaking changes

- Tool error reporting now uses the Python-native error flag; re-verify consumers that inspect tool result failure status or error semantics.
- Structured tool result envelope and frontend payload serialization changed; re-check code parsing tool results or snapshots.

## 0.2.1 — 2026-10-12

- Runs no longer load the host's `~/.claude` settings or the working directory's `CLAUDE.md`. `claude-agent-sdk` 0.2 loads them when `setting_sources` is unset; the adapter now defaults it to `[]`, as 0.1 behaved. Pass `setting_sources` to opt back in.

### Breaking changes

None.

## 0.2.0 — 2026-10-12

- Requires AG-UI 1.0 (`ag-ui-protocol>=1.0.0`). `RUN_STARTED` declares `protocol_version`.
- Audio and video parts are skipped with a warning; other multimodal input is preserved.
- Errored turns end with `RUN_ERROR` instead of `RUN_FINISHED`, without duplicate assistant messages.
- Tool calls on the non-streaming fallback path carry `parent_message_id` (#2118).
- Sessions survive input errors.
- The endpoint helper forwards FastAPI route kwargs (`name`, `tags`, `dependencies`, …).

### Breaking changes

None.
