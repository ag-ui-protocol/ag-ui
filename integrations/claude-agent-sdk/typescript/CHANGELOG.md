# Changelog

## 0.0.8 — 2026-10-21

- Fixed queued SDK recovery turns to wait for each turn to finish before proceeding.
- Completed batches are now cleared before later failures to avoid stale state.
- Deferred batches are persisted before interrupted streams.
- Unsupported pending tool batches are retained and rejected rather than silently dropped.
- Unresolved child tool identities are retained during recovery.
- SDK middleware tools now complete correctly and recovery input is retained.
- Historical errors and results are preserved in metadata during approval recovery.

### Breaking changes

None.

## 0.0.7 — 2026-10-15

- Preserves split content and renders qualified tool names.
- Recovers default frontend tool calls and reconciles state snapshots.
- Preserves profile context and expires local bindings.
- Restores frontend tool results through ready MCP transport, including failure status.
- Restores original sessions and supports native deferred approvals.
- Retains native structured tool result envelope and canonical frontend payloads.
- Retains media diagnostics and native tool names.

### Breaking changes

- Tool result serialization and frontend payload format changed; re-verify handling of tool names, result envelopes, and failure statuses.

## 0.0.6 — 2026-10-12

- Runs no longer load the host's `~/.claude` settings or the working directory's `CLAUDE.md`. Recent `@anthropic-ai/claude-agent-sdk` 0.2 releases load them when `settingSources` is omitted; the adapter now defaults it to `[]`. Pass `settingSources` to opt back in.

### Breaking changes

None.

## 0.0.5 — 2026-10-12

- Requires AG-UI 1.0 (`@ag-ui/core` / `@ag-ui/client` `>=1.0.0`). `RUN_STARTED` declares `protocolVersion`.
- Audio and video parts are skipped with a warning; tool-result content parts are flattened to text, and file sources are dropped with a warning.
- After a display-only frontend tool, the adapter no longer resumes with an empty prompt, so the `followUp: false` workaround is no longer needed.

### Breaking changes

None.

## 0.0.4

- Publish the declared MIT license and license file in the npm package.
