# Changelog

## 1.1.4 — 2026-09-14

- Server tools can now show a live "running" step via opt-in `MastraAgentConf` live `TOOL_CALL_START` emission.
- Resumed runs now receive the frontend tools of the run they continue, so frontend-only agents no longer end with no output.
- Mastra `tripwire` chunks now surface their reason as assistant text instead of ending the run silently; terminal retry reasons are preserved.
- Developer messages are now forwarded (mapped to user role) instead of being dropped.
- Thread-scoped working memory is now seeded on a new thread, preventing "Thread not found" errors on the first turn.
- Resume now emits `TOOL_CALL` start/args/end before the result and preserves streamed tool arguments.
- Replay conversion recovers from malformed or concatenated tool-call argument strings instead of failing all later runs.
- Results paired with skipped replay calls are now dropped; suppressed spurious warning on brand-new threads.

### Breaking changes

None.

## 1.1.3 — 2026-09-08

- Report remote token usage from Mastra runs.
- Add `onTextBuffered` callback so segment identity is preserved when `useProcessedFinalText` buffers deltas past a tool-call boundary.
- Honour a caller-supplied client abort signal by chaining it into the run's controller instead of overriding it.
- Cancel remote runs at the producer via a per-run cloned client, stopping server-side production and billing on abort.
- Give each assistant text segment its own continuation id.
- Propagate cancellation from Observable teardown.
- Settle aborted runs instead of silently dropping chunks.

### Breaking changes

- Peer dependency floors for ag-ui core and client raised to 0.0.58.
