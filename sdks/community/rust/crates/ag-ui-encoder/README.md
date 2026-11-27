# ag-ui-encoder

A small framework/runtime-independent AG-UI 1.0 JSON/SSE producer encoder, using
canonical `ag-ui-core::event::Event` types. No HTTP server, protobuf negotiation,
state store, retries, or lifecycle authority is included. Rust 1.88 or later.

## Producer integration

1. Apply a request-byte limit before parsing JSON.
2. Call `ag_ui_core::processing::normalize_run_input(raw_json)` before admitting
   the run or sending successful streaming response headers. Unknown protocol
   material is stripped with structured diagnostics; malformed known fields and
   unsupported major versions reject the request. Newer supported-major minors
   and uninterpretable declarations proceed with warnings. Optional state null
   converges on wire omission; `effective_state` is `{}` when absent. Open state,
   metadata, parameters and forwarded values preserve nested nulls.
3. Apply host authentication/admission/history policy. The SDK does not implement
   these application policies.
4. Send `CONTENT_TYPE`, then `Encoder::encode_live` for each canonical event.
   This live-producer helper declares the SDK's own `1.0` on `RUN_STARTED`, without
   echoing the request's version, fabricating identifiers, or creating lifecycle
   events. Finish and close the transport according to your host's policy.

```rust
use ag_ui_core::{event::Event, processing::normalize_run_input};
use ag_ui_encoder::{Encoder, CONTENT_TYPE};
use serde_json::json;

let accepted = normalize_run_input(json!({
    "threadId":"thread-1", "runId":"run-1", "messages":[]
}))?;
assert_eq!(accepted.effective_state, json!({}));
let started: Event = serde_json::from_value(json!({
    "type":"RUN_STARTED", "threadId":"thread-1", "runId":"run-1"
}))?;
let encoder = Encoder::default();
let bytes = encoder.encode_live(&started)?;
assert_eq!(CONTENT_TYPE, "text/event-stream; charset=utf-8");
# Ok::<(), Box<dyn std::error::Error>>(())
```

## Stateless serialization and bounds

`encode` / `encode_string` validate and normalize one event and preserve an absent
`protocolVersion`; use these for exact serialization or replay of existing
canonical declarations. Use `encode_live` for live production. Every event is one
compact JSON payload, UTF-8 without a BOM, prefixed by `data: ` and terminated by
LF LF. Embedded CR/LF are JSON-escaped. Optional whole JSON nulls are omitted;
required snapshot/patch/RAW/CUSTOM null values and nested nulls survive. Known
JSON Patch operations retain legal additional members, without allowing the
extension map to shadow their defined fields. Deprecated `THINKING_*`, illegal
attribution, roles, pointers and out-of-range integers are rejected.

`Encoder::new(Limits { max_event_bytes, max_comment_bytes })` configures finite
byte limits including SSE framing. Defaults are 16 MiB per event and 64 KiB per
comment, allowing common inline media while remaining bounded. Output buffers
are capped; oversized data returns `EncodeError::SizeLimit` without partial output
or truncation. The caller still owns limits on input parsing and canonical event
allocation, which precede encoding.

`keepalive` safely prefixes every input line with `: `, normalizes CR/CRLF to LF,
and adds a final blank line. Comments never contain data fields and cannot inject
SSE `data`, `event` or `id` fields. Standalone `encode`, `encode_live`, and
`keepalive` functions use default limits.

Individual event validation does not prove lifecycle ordering, successful remote
execution, durable authority, or registry publication readiness. Use the verified
Git dependency recipe in the workspace README while crate versions are unpublished.
