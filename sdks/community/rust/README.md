# Rust SDK migration proposal

This branch proposes `ag-ui` 1.0.0 as a community SDK for the frozen AG-UI
1.0 protocol. It adds the feature-based crate alongside the existing
`ag-ui-core` and `ag-ui-client` crates. Their AG-UI 1.0 implementation is
under review in [#3214](https://github.com/ag-ui-protocol/ag-ui/pull/3214).
The upstream team and maintainers decide adoption and review responsibilities.

| Package | Role |
| --- | --- |
| `ag-ui` | Proposed SDK: protocol types, server, client and Axum features |
| `ag-ui-core`, `ag-ui-client` | Existing community SDK, retained during review |
| `ag-ui-xtask` | Unpublished protocol drift checks |
| `ag-ui-migration-tests` | Unpublished HTTP/SSE and documentation tests |

See [MIGRATION.md](MIGRATION.md) for API differences and transition decisions,
and [PROVENANCE.md](PROVENANCE.md) for the source revision and scope of this import.
The [transition checklist](docs/transition.md) separates this source change from
the open ownership, maintenance and publishing decisions.

## Try the candidate

Use a local dependency while reviewing this branch:

```toml
[dependencies]
ag-ui = { path = "path/to/ag-ui/sdks/community/rust/crates/ag-ui", features = ["http"] }
```

For the released SDK, use `ag-ui = { version = "1.0.0", features = ["http"] }`.
Requests and `RUN_STARTED` declare wire version `1.0`. [crates.io package](https://crates.io/crates/ag-ui/1.0.0)

### Client

```rust,no_run
use ag_ui::client::HttpAgent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let agent = HttpAgent::new("http://127.0.0.1:3000/agent")?;
    let mut thread = agent.thread("conversation-1");
    let report = thread.send("Hello")?.collect_report().await;
    println!("{:?}", report.end);
    Ok(())
}
```

### Server

Enable `axum` to host an agent. The application supplies model and tool behavior.

```rust
use ag_ui::axum::RouterExt;
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::RunOutcome;

struct Greeter;

impl Agent for Greeter {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.say("Hello from Rust.")?;
        Ok(RunOutcome::Success)
    }
}

let app: axum::Router = axum::Router::new().route_agui("/agent", Greeter);
```

Run a server and client together, without credentials or external services:

```sh
cd sdks/community/rust
cargo run --locked -p ag-ui-migration-tests --example local_round_trip
```

### Streaming through a proxy

`AgentEndpoint` sends an SSE comment after 15 seconds without an event. Clients
ignore these comments; they keep an idle connection active while a model or tool
is working. Use `.keep_alive(interval)` to choose an interval below your proxy's
idle timeout, or `.without_keep_alive()` to disable the comments. The lower-level
`SseResponse` builder enables them only when `.keep_alive(interval)` is set.

The native `Runner` event queue is unbounded by default. For a producer that may
outrun its client, configure a queue limit explicitly:

```rust
use ag_ui::axum::{AgentEndpoint, RouterExt};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::RunOutcome;
use std::{num::NonZeroUsize, time::Duration};

struct Greeter;
impl Agent for Greeter {
    type State = ();
    async fn run(&self, _: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        Ok(RunOutcome::Success)
    }
}

let endpoint = AgentEndpoint::new(Greeter)
    .keep_alive(Duration::from_secs(10))
    .event_buffer_capacity(NonZeroUsize::new(128).unwrap());
let app: axum::Router = axum::Router::new().route_agui_with("/agent", endpoint);
# let _ = app;
```

The limit counts queued events, not payload bytes. If a run-owned stream
overflows, it sends a terminal `RUN_ERROR` with code `EVENT_BUFFER_FULL` and
closes. Applications that execute a durable run independently must own its
persisted state and reconnect/replay policy; losing an SSE subscriber does not
prove that the run failed. The queue default remains unchanged while deployment
limits are evaluated. The real-HTTP tests cover the configured overflow, default
keep-alive interval, custom interval and explicit disable setting.

The default `verify` feature checks event ordering before the server emits a
terminal event. A host that disables it takes responsibility for closing open
messages and tool calls before reporting a cancelled run.

## Checks

Rust currently has no Nx project target; these are the Cargo commands used by
the Rust workflow. Run them from `sdks/community/rust`:

```sh
cargo test --locked --workspace --all-features
cargo run --locked -p ag-ui-xtask -- drift-check --local
cargo clippy --locked -p ag-ui -p ag-ui-xtask -p ag-ui-migration-tests --all-targets --all-features -- -D warnings
npm ci --ignore-scripts --prefix interop
npm test --prefix interop
npm ci --ignore-scripts --prefix e2e/interop
npm test --prefix e2e/interop
```

`--local` reads the frozen `spec/1.0/schema.json` from this checkout. It checks
normative event names, payload field names, optionality and mapped Rust wire
types against the schema. Pinned schema signatures detect deeper changes to
field shapes, unions and serialization rules
that need review. The five retired `THINKING_*` variants are recorded separately
for historical input compatibility. The gate fails when its source is unavailable
or cannot be compared. It does not by itself prove every Rust value conforms;
wire, stream-conformance and cross-language tests complement it.
The semantic suite checks 44 cases against `@ag-ui/core@1.0.4`. Each
intentional representation or acceptance difference is recorded in its fixture.
The independent `interop/` suite checks the 31 canonical event types against the
TypeScript source in this checkout and the five retired thinking fixtures through
Rust's compatibility codec. The Rust tests run the frozen schema fixtures and
conformance streams from `spec/1.0/`, including the documented Rust replacement
for the reference client's unknown-role exception.

The import excludes A2UI, live model tests, the standalone documentation site and
standalone publishing workflows. JSON/SSE is implemented; the `protobuf` feature only exposes
an explicitly unsupported formatter and is not a working binary transport.

The monorepo-specific [publishing workflow](docs/publishing.md) is proposed
separately from the standalone release automation. It runs manually, defaults to
verification only, and can publish `ag-ui` from the official repository's `main`.
