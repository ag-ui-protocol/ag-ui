# Changelog

## 1.1.0 (unreleased)

- Adds the `Agent` interface: the public surface of an agent as a structural type. Agents from any copy or version of `@ag-ui/client`, including 1.0.x, fit it. `AbstractAgent` implements it, and `clone()` on a value typed `Agent` returns `Agent`.
- `AgentSubscriber` and `AgentSubscriberParams` take a type parameter for the type of `agent`. The default is `AbstractAgent`. Use `AgentSubscriber<Agent>` for agents from any copy.
- Adds the `MiddlewareNext` type: the `run`, `messages`, and `state` members that a middleware gets as `next`. `Middleware.run()`, `runNext()`, and `runNextWithState()` take it.
- Adds the protected `copyStateTo()` method. A `clone()` override that builds a new instance with `new` uses it to copy messages, state, thread, subscribers, middlewares, and interrupts.
- Adds `activeRunCompletion`: a promise that resolves when the active run ends, or `undefined` when no run is active.
- Adds `supportsConnect()`: `true` when the agent overrides `connect()` or `connectAgent()`.
- `connectAgent()` takes an `options` argument. Set `verifyEvents: false` to skip event verification on the connect stream.
- Adds `isHttpAgent()`: checks if a value is an `HttpAgent`, also when another copy of `@ag-ui/client` made it.

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
