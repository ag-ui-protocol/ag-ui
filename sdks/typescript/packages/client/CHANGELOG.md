# Changelog

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
