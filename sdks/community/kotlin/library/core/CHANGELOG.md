# Changelog

## 0.5.0 — 2026-11-05

- Aligned the SDK with AG-UI 1.0, including strict event/input decoding and state patch structural checks.
- Added REASONING_* events; THINKING_* events and ThinkingTelemetryState are deprecated with ReplaceWith hints.
- Added interrupt protocol support (`Interrupt`, `ResumeStatus`, `ResumeEntry`) on RUN_FINISHED outcomes.
- Added ACTIVITY_SNAPSHOT/ACTIVITY_DELTA events, ActivityMessage, Role.ACTIVITY, ToolMessage.error, and multimodal UserMessage support.
- Added wasmJs (browser) and macosArm64 targets across core, client, and tools.
- Fixed JSON Pointer validation to avoid stack overflow on long pointers across JVM, Wasm, and Native.
- RunFinishedSuccessOutcome now serializes to exactly `{"type":"success"}`.
- Tool-result content arrays serialize without string fallback.

### Breaking changes

- Targets AG-UI 1.0; strict event/input decoding and tightened validation may reject previously accepted payloads.
- Usage counts validated as exact safe JSON integers; decimal/exponent spellings normalized.
- Explicit-null checks tightened across nested typed models and message/outcome names.
- THINKING_* events, ThinkingTelemetryState, and AgentState.thinking deprecated; migrate to REASONING_*/ReasoningTelemetryState.
- kotlin-json-patch dependency dropped; StateManager uses the internal RFC 6902 implementation.
- Group ID changed to com.ag-ui.community; com.contextable/com.agui references removed.
- minSdk lowered to 24; Kotlin pinned to 2.1.20.
- RunFinishedSuccessOutcome serialization now emits only the type key; verify consumers tolerant of extra fields.
