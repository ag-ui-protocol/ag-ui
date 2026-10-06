# Changelog

## 1.1.6 — 2026-10-01

- Fixed resumed tool calls being released under a generated message id when output arrived before Mastra announced the turn's message id, which could duplicate the call on the next turn.
- Early-arriving output now waits behind the call and replays in order once the native id is known, with a bounded buffer falling back to the run's own id.

### Breaking changes

None.

## 1.1.5 — 2026-09-30

- Native tool approvals (requireApproval / requireToolApproval) now surface as interrupts with reason `mastra:tool_approval` and complete via Mastra's approveToolCall / declineToolCall.
- Malformed tool approval answers now fail the run with a `RUN_ERROR` coded `MASTRA_INVALID_TOOL_APPROVAL`, leaving the approval pending.
- Failed runs now end with exactly one `RUN_ERROR` event before completing the Observable; cancellation settles without `RUN_ERROR`.
- Resumed tool calls stay under the message that owns them, and resumed text gets a new continuation id instead of appending to an old message.
- Resume is decided by the entry's status, not the payload; a resolved entry with no payload resumes rather than declines.
- `RunAgentInput.resume` now takes precedence over the deprecated `forwardedProps.command`.
- Original attachment filenames and image MIME types are preserved in native memory.
- Per-run remote handles are reused instead of rebuilt, fixing 404s when configured agentId differs from the backend agent.
- Public agentId aliases are retained across clone() and runtime aliases; empty configured agentId is treated as unset.
- Adapter validators come from `@ag-ui/core/schemas` and follow the 1.0 part renames.
- CopilotKit peer dependency is now optional.

### Breaking changes

- Tool approval resume now approves only on `true` or `{ approved: true }` and declines only on cancelled, legacy `false`, or `{ approved: false }`; any other answer fails the run.
- Failed runs now emit a terminal `RUN_ERROR` event where previously none was emitted; consumers relying on the prior behavior should re-verify.
- `RunAgentInput.resume` now overrides `forwardedProps.command`; verify resume handling.
- Resume behavior is now driven by entry status rather than payload value; re-verify resume/decline flows.
- Adapters follow 1.0 model part renames and flatten/drop parts per provider; re-verify content handling.

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
