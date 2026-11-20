# Changelog

## 1.0.1 — 2026-10-12

- The run-start helper now sets `ProtocolVersion` to `AGUIProtocol.Version` on the `RUN_STARTED` event it builds, as AG-UI 1.0 requires. A caller-supplied `RunStartedEvent` passes through unchanged. Snapshot or baseline tests of the event stream gain the `protocolVersion` field.

### Breaking changes

None.

## 1.0.0 — 2026-09-17

- Moved onto the generated 1.0 models.
- Added typed access to AG-UI client state.

### Breaking changes

- Models track the 1.0 schema names; re-verify types and serialization behavior after upgrade.
