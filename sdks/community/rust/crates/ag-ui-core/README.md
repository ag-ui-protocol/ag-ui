# AG-UI Core 0.2.0

Canonical Rust types for AG-UI 1.0: seven message roles, multimodal content,
current event families, typed JSON Patch, run outcomes, usage, interrupts,
resume entries, opaque reasoning artifacts, and subagent attribution.

## Processing boundaries

Use `processing::normalize_run_input` on raw JSON before accepting a producer
request. It returns a canonical `types::RunAgentInput`, `effective_state`, and
structured diagnostics. An absent or whole-null optional state has an effective
`{}` baseline. Required snapshots and nested nulls are preserved.

Use `processing::normalize_event` for tolerant consumer ingress. Unknown
closed members/union material are diagnosed and stripped where permitted;
malformed known values fail. Unknown events may produce no canonical event.
Open application JSON and legal patch-operation extension members survive.

Use `processing::prepare_run_input` for the non-mutating outgoing request
projection: validate known values, omit optional whole-null fields, exclude
activity history, and declare the consumer's own 1.0 version. Use
`processing::normalize_producer_event` for strict producer-output validation;
`ag-ui-encoder` invokes it before producing any bytes.

`TextMessageStartEvent.role` is optional, preserving an omitted wire role;
application reducers default omission to assistant. Each known JSON Patch
operation has an `extra` map for legal extension members. The serializer rejects
extras that would shadow that operation's typed reserved fields.

Serde `Deserialize` is a representation operation, not a full conformance claim.
The strict JSON Schema oracle, tolerant ingress, and producer egress are separate
test lanes. Diagnostics have stable categories and RFC 6901 paths, with bounded
sanitized details rather than payload logging.

Versions are numeric `MAJOR.MINOR`: absent/current declarations proceed; newer
minor and uninterpretable declarations warn; unsupported request majors fail
before admission. The compatibility boundary translates deprecated thinking
events and binary content before current-1.0 processing.

## Recorded event streams

For lifecycle-verified application of recorded events, use an `ag-ui-client`
custom `Agent::run` adapter through `Agent::run_input`. Normalize raw JSON through
`CompatibilityBoundary` before typed deserialization. The client verifies
lifecycle ordering, applies patches, and reconciles complete message history.
Carry full messages into later turns rather than a text-only projection. Core
does not supply a separate replay reducer or persistence engine.

## Matching protocol enums

Public protocol enums are non-exhaustive. Include a wildcard branch in external
matches so future protocol variants can be added without breaking consumers.
Public structs remain constructible with struct literals; adding required
fields to those types may still require a breaking Rust release.
