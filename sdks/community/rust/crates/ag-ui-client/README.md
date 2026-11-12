# AG-UI Rust Client 0.2.0

HTTP/SSE client for AG-UI 1.0 with explicit lifecycle, canonical event processing,
complete application history, structured diagnostics, and bounded transport.

## Transport features

Default features keep the HTTP transport with native TLS. HTTP/2, charset
decoding and system-proxy support remain enabled for every HTTP build, preserving
the prior reqwest defaults apart from the selectable TLS backend. To select rustls instead:

```toml
ag-ui-client = { version = "0.2.0", default-features = false, features = ["rustls-tls"] }
```

Use `default-features = false` with no additional features for a custom `Agent`
without reqwest or a TLS backend. The lifecycle pipeline, subscribers, and bounded
`SseDecoder` remain available. `HttpAgent`, its builder, reqwest error variants,
and the reqwest `SseResponseExt` implementation require `http`. The `http` feature
alone enables plain HTTP without TLS; `native-tls` and `rustls-tls` each enable it.
Cargo features are additive: disable defaults when selecting rustls to avoid also
enabling native TLS through this dependency. Other dependencies may still enable
reqwest features in the final application.

## Same-thread turns

Use `Agent::run_input` with a complete `core::types::RunAgentInput`. Each turn
has a new run ID, while the thread ID stays stable. Reuse the complete public
`messages` collection and `new_state`; `new_messages` only reports additions and
cannot reconstruct snapshot replacements/deletions.

```no_run
# #[cfg(feature = "http")]
# mod example {
use ag_ui_client::{Agent, HttpAgent, RunTerminalStatus};
use ag_ui_client::core::types::RunAgentInput;
use serde_json::json;

# #[tokio::main]
# async fn main() -> Result<(), Box<dyn std::error::Error>> {
let agent = HttpAgent::builder()
    .with_url_str("http://127.0.0.1:3000/agent")?
    .build()?;
let mut input = RunAgentInput::new(
    "thread-1", "run-1", json!({}), vec![], vec![], vec![], json!({}),
);
let first = agent.run_input(&input, ()).await?;
if let RunTerminalStatus::ProducerError(error) = &first.terminal_status {
    return Err(format!("producer error: {}", error.message).into());
}
input.messages = first.messages;
input.state = first.new_state;
input.run_id = "run-2".into();
let second = agent.run_input(&input, ()).await?;
# let _ = second;
# Ok(())
# }
# }
```

`run_input` preserves IDs, parent, tools, context, resume, and forwarded properties
and uses the same verifier/reducer/subscriber pipeline as `run_agent`.
`RunAgentParams::with_thread_id` makes a convenience call use an explicit thread;
otherwise `run_agent` creates a fresh thread. `Agent::run` is a low-level event
stream without the helper's completion guarantees.

## Results and application state

`RunAgentResult` exposes complete `messages`, `new_state`, `terminal_status`,
`outcome`, `usage`, and optional `result`. `result` contains producer output only
on success; absent or whole-null output becomes `None`, while nested nulls are
preserved. Cancellation, interruption, and producer errors have no successful
result. The latest producer segment controls terminal status: a `RUN_ERROR` is
a producer error even after an earlier finish; a later run can complete after
historical segments. Producer-canonicalized thread/run IDs are accepted, while
terminal lifecycle completion is required. Consumer protocol, transport, and
callback failures return `Err`. Finalization runs once per subscriber on ordinary
success and `Result` failure paths. Dropping the future or panicking in a callback cannot await asynchronous
finalizers. Dropping releases the connection; it does not cancel remote work.

An absent/whole-null optional input state is omitted and starts from `{}`.
Required null snapshots stay null. Carry `new_state` normally into the next input;
normalization reestablishes the wire rule. The default JSON state accepts scalars,
arrays, and nested nulls. Custom application types can explicitly fail conversion.

Activity messages stay in application history and are filtered from outgoing
conversation history. Roles, IDs, metadata, media, tool-result correlation,
opaque values, and subagent attribution remain intact. Message snapshots use
role-aware reconciliation and preserve established positions. State/activity
patches apply on a copy and commit atomically. Use full messages for next-turn
history; text-only helpers cannot preserve these semantics.

## Transport and diagnostics

HTTP sends JSON input and requests SSE, overriding conflicting custom
`Content-Type`/`Accept`. It rejects non-success statuses and missing/wrong
response media types before event application. The decoder tolerates arbitrary
UTF-8 byte partitions, LF/CRLF/CR, an initial BOM, multiple frames, and keepalives.
Malformed/truncated tails fail even after an earlier terminal event.

Defaults bound lines to 16 MiB and frames to 16 MiB + 1024 bytes. Set
`HttpAgentBuilder::with_sse_limits` to override. Non-success response reading is
bounded by 64 KiB and two seconds by default (`with_error_body_limits`). The
captured prefix is retained in `AgUiClientError::HttpStatus` and is available via
`error.http_error_body()`. Explicit `bytes()` and UTF-8 `text()` accessors may
reveal server-echoed secrets; apply application-level filtering before logging.
Both the error and body wrapper omit contents from `Display` and `Debug`.
`stop_reason()` distinguishes completion, byte limit, timeout, and read failure;
`is_truncated()` conservatively reports any unobserved end (including exactly
reaching the limit). Partial bytes survive timeouts/read failures. Set
`ErrorBodyLimits.max_bytes` to zero to disable capture. Dropping a stream releases local resources
without claiming remote cancellation.

`with_diagnostic_handler` observes structured core processing diagnostics.
Subscribers receive lifecycle/reducer diagnostics. Paths are RFC 6901 pointers,
categories are structured, and details exclude opaque payloads. Current AG-UI
1.0 forward compatibility and deprecated thinking/binary translation are
supported. Reconnect, protobuf, and server persistence are not provided.

## Optional live starter examples

The hermetic test suite does not require a separately launched service. For the
optional `basic_agent` and `shared_state` examples, run the repository's Python
server starter at port 3001, then run `cargo run --example basic_agent` or
`cargo run --example shared_state` from the Rust workspace. Set `AG_UI_BASE_URL`
to select another host. These live examples are separate from CI evidence.
