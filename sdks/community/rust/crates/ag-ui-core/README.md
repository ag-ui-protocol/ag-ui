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

## Constructing and matching protocol values

Public protocol enums and record structs are non-exhaustive. Include a wildcard
branch in external enum matches and `..` when destructuring a record. Construct
records with `new(...)` for required fields or `Default::default()` for
all-optional records, then set optional public fields. Event constructors start
with an empty `BaseEvent`; `with_base(...)` supplies common metadata. Existing
message constructors and fluent helpers remain available.

```rust
use ag_ui_core::{event::{BaseEvent, RunFinishedEvent}, types::{Interrupt, ResumeEntry, ResumeStatus, TokenUsage}};
use serde_json::json;

let mut base = BaseEvent::default();
base.timestamp = Some(123);
let mut usage = TokenUsage::default();
usage.total_tokens = Some(42);
let mut finished = RunFinishedEvent::new("thread", "run").with_base(base);
finished.result = Some(json!({"answer": 42}));
finished.usage = Some(vec![usage]);

let mut interrupt = Interrupt::new("approval".into(), "permission".into());
interrupt.message = Some("May I proceed?".into());
let mut resume = ResumeEntry::new("approval".into(), ResumeStatus::Resolved);
resume.payload = Some(json!({"approved": true}));
```

### Migrating struct literals

Replace `Type { required, optional, .. }` with `Type::new(required)` and optional
field assignments. For `BaseEvent`, chunks, capabilities, and `TokenUsage`, start
with `Type::default()`. Even `Type { ..Type::default() }` cannot be used outside
this crate. Opaque ID and JSON Pointer newtypes retain their existing APIs.
This lets future optional protocol fields be added without forcing downstream
callers to update literals. Constructors do not replace protocol validation;
use the processing boundaries above for ingress and egress.

For example, external event literals are intentionally rejected:

```compile_fail,E0639
use ag_ui_core::event::{BaseEvent, TextMessageEndEvent};
let event = TextMessageEndEvent {
    base: BaseEvent::default(),
    message_id: "message".into(),
};
```

The same rule applies to nested payload records:

```compile_fail,E0639
use ag_ui_core::types::SubagentInfo;
let info = SubagentInfo { name: "research".into(), description: None };
```

And all-optional capability records:

```compile_fail,E0639
use ag_ui_core::types::ExecutionCapabilities;
let capabilities = ExecutionCapabilities {
    code_execution: Some(true),
    ..ExecutionCapabilities::default()
};
```
