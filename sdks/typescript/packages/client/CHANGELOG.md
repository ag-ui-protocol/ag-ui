# Changelog

## 1.0.4 — 2026-11-05

- Stopped deep-cloning the entire thread per event; each update now copies only changed messages, removing quadratic cost on long threads.
- Emitted messages are read-only; emitted state and activity content are copied so consumer edits no longer leak into the reducer's working copy or later events.
- `threadId` is now a lazily-generated accessor, allowing agents to be constructed at Cloudflare Worker global scope without crashing.
- Reworked tool-result/call pairing: results are re-paired with their calls on run input, snapshot merges, and across reused call ids, human-in-the-loop, and reasoning messages.
- Tool results now placed in front of reasoning rather than after, fixing LangGraph/Mastra handling.
- Added a per-event entry budget to bound schema enforcement work against unbounded container sizes (CVE-2023-54404 mitigation).
- `zod` is now a peer dependency (`^3.25.18 || ^4.0.0`) instead of a direct dependency.
- Fixed dropped awaits on async `onNewMessage` and `onNewToolCall` hooks.
- Avoided serializing discarded unknown events.
- Mastra: `clone()` now carries `use()` middlewares onto cloned agents.

### Breaking changes

- `threadId` is now an accessor on `AbstractAgent`; subclasses declaring or overriding `threadId` as a field fail (TS2610). Assign it in the constructor instead.
- `threadId` is no longer an own property; it is absent from `Object.keys`, spread, and `JSON.stringify` until read.
- `zod` moved from a direct to a required peer dependency (`^3.25.18 || ^4.0.0`); applications must install a compatible zod.
- `AbstractAgent.middlewares` is now protected.
- Tool-result ordering and re-pairing behavior changed; re-verify any code relying on prior message ordering.

## 1.0.3 — 2026-10-15

- Maintenance release; no consumer-facing changes identified.

### Breaking changes

None.

## 1.0.2 — 2026-10-05

- The client now accepts more optional fields sent as `null` and treats them as absent, with one warning per field per run. Previously these failed the run.
- Events received before an agent's error (including `RUN_ERROR`) now reach `onEvent` and `onRunErrorEvent` instead of being dropped.
- HTTP stream cleanup failures no longer mask the original stream error.

### Breaking changes

None.

## 1.0.1 — 2026-09-29

- Fixed `connectAgent()` failing when reconnecting to a thread with pending interrupts; connects now read thread history without requiring resume answers.
- The resume/interrupt check now applies only to inputs that submit answers, allowing reloads to restore interrupted threads.

### Breaking changes

None.

## 1.0.0 — 2026-09-17

- Adds the 1.0 enforcement pipeline that runs after middleware: strip against the schema and validate.
- Adds protobuf wire support and compatibility middleware.
- Snapshot metadata now lets a producer declare only its authoritative activity types, so projectors like A2UI middleware don't delete activity other producers own.
- MESSAGES_SNAPSHOT now applies in snapshot order instead of appending unseen messages at the end, repairing re-keyed message ordering.
- Fixes scoped activity deletion without reordering history and preserves full activity snapshot authority.
- Bounds the replay buffer and caps SSE and protobuf framing buffers to avoid retaining entire responses.
- Stops upstream reads and cancels the HTTP reader on stream failure, not only on completion.
- Reasoning events no longer overwrite an activity message sharing the same id.
- Each run now gets its own set of blocked tool-call IDs, so a stalled run's filtered events are no longer leaked.
- FilterToolCallsMiddleware clears blocked tool-call IDs on run boundaries.
- Guards JSON.parse and surfaces stream errors in legacy convert and a2a middleware.

### Breaking changes

- The wire protocol version is now the generated PROTOCOL_VERSION ("1.0").
- Enforcement pipeline now runs after middleware and strips/validates against the schema, changing which events pass through.
- MESSAGES_SNAPSHOT ordering and activity-ownership semantics changed; re-verify snapshot handling.
- Framing buffers are now capped; oversized unbounded streams will error instead of growing.
