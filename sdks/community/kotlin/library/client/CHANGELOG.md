# Changelog

## 0.5.0 — 2026-11-05

- Aligned the client with AG-UI 1.0, including run-input handling and state application.
- Activity messages are now stripped from the run input sent to the agent.
- Added REASONING_* event support; THINKING_* deprecated with ReplaceWith hints.
- Added wasmJs (browser) and macosArm64 targets.
- State patches applied without recursion to avoid stack overflow on deeply nested state.
- Preserve multimodal tool contents, metadata, and subagent attribution across history paths.
- Documented that a malformed STATE_DELTA is fatal to the flow, while an inapplicable delta is reported via onStateError.

### Breaking changes

- StateManager now rejects deltas it previously accepted: replace/remove of a missing member, add under a missing parent, move into its own child, and add without a value.
- Rejected deltas report `com.agui.client.state.JsonPatchApplicationException` instead of kotlin-json-patch exception types.
- MAX_JSON_DEPTH reduced from 512 to 128; deeply nested SSE payloads are refused.
- `catch (e: Error)` removed from commonMain; over-nested SSE payloads are refused rather than swallowed.
- Activity messages are no longer echoed back in run inputs.
- Numeric delta comparison is now by value (1 equals 1.0).
- Group ID changed to com.ag-ui.community; minSdk lowered to 24; Kotlin pinned to 2.1.20.
