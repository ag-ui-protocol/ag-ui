# Changelog

## 1.0.1 — 2026-10-12

- Optional fields without a value are now left out of the JSON even when a host inserts the serializer context into its own `JsonSerializerOptions`, as AG-UI 1.0 requires. Under Microsoft Agent Framework on .NET 10, events were sent with `null` optional fields (e.g. `parentRunId`, `input`, `subagentRunId`). Snapshot or baseline tests that recorded those `null` keys need updating.

### Breaking changes

None.

## 1.0.0 — 2026-09-17

- Models are now generated from the frozen AG-UI 1.0 JSON Schema, covering content parts, tool result parts, capabilities, run outcomes, token usage with cache writes, and file source.
- `PROTOCOL_VERSION` now reads "1.0"; generated headers name the 1.0 schema address.
- Generator emits the `AGUIProtocol` type.

### Breaking changes

- Models renamed to their 1.0 names; verify usages against the generated types.
- Optional nulls are omitted on serialization while payload nulls are preserved.
- Protocol version constant value changed to "1.0".
