# Changelog

## Unreleased

- Added event middleware, the counterpart of the TypeScript SDK's `Middleware`. `AGUIMiddleware` receives the run input and the next stage (`AGUIRunDelegate`) and returns the events that continue toward the wire. `AGUIMiddlewarePipeline` composes them around a terminal stage, outermost first. `IChatClient.AsAGUIRunDelegate(...)` builds that terminal stage from a chat client, so an endpoint with and without middleware differs only in the pipeline.
- Added `FilterToolCallsMiddleware`, which hides tool calls by name (`Allow` or `Disallow`) while the agent still runs them. Besides the `TOOL_CALL_*` events it removes hidden calls from `MESSAGES_SNAPSHOT`, strips `rawEvent` data that mentions them, and drops `RAW` events that mention them.

### Breaking changes

None.

## 1.0.1 — 2026-10-12

- The run-start helper now sets `ProtocolVersion` to `AGUIProtocol.Version` on the `RUN_STARTED` event it builds, as AG-UI 1.0 requires. A caller-supplied `RunStartedEvent` passes through unchanged. Snapshot or baseline tests of the event stream gain the `protocolVersion` field.

### Breaking changes

None.

## 1.0.0 — 2026-09-17

- Moved onto the generated 1.0 models.
- Added typed access to AG-UI client state.

### Breaking changes

- Models track the 1.0 schema names; re-verify types and serialization behavior after upgrade.
