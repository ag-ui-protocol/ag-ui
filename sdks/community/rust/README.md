# Rust SDK migration proposal

This branch adds the feature-based `ag-ui` crate alongside the existing community
Rust SDK for review. The `ag-ui-core` and `ag-ui-client` source, public APIs and
packaging checks remain in place. Whether to adopt the new implementation and
remove the existing source is a separate decision for the upstream team and
maintainers.

| Package | Role |
| --- | --- |
| `ag-ui` | Proposed SDK: protocol types, server, client and Axum features |
| `ag-ui-core`, `ag-ui-client` | Existing community SDK, retained during review |
| `ag-ui-xtask` | Unpublished protocol drift checks |
| `ag-ui-migration-tests` | Unpublished HTTP/SSE and documentation tests |

See [MIGRATION.md](MIGRATION.md) for API differences and transition decisions,
and [PROVENANCE.md](PROVENANCE.md) for the source revision and scope of this import.
The [transition checklist](docs/transition.md) separates this source change from
the ownership, final legacy releases, and upstream approval still to be agreed.

## Try the candidate

Use a local dependency while reviewing this branch:

```toml
[dependencies]
ag-ui = { path = "path/to/ag-ui/sdks/community/rust/crates/ag-ui", features = ["http"] }
```

The published standalone `ag-ui` crate is separate from this proposal; installing
it from crates.io does not select the changes in this branch.

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

`AgentEndpoint` leaves SSE keep-alive off and the native `Runner` event queue
unbounded by default. For an endpoint behind a proxy that closes idle responses,
enable comments at an interval below that proxy's idle timeout. For a producer
that may outrun its client, configure a queue limit explicitly:

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
    .keep_alive(Duration::from_secs(15))
    .event_buffer_capacity(NonZeroUsize::new(128).unwrap());
let app: axum::Router = axum::Router::new().route_agui_with("/agent", endpoint);
# let _ = app;
```

The limit counts queued events, not payload bytes. If a run-owned stream
overflows, it sends a terminal `RUN_ERROR` with code `EVENT_BUFFER_FULL` and
closes. Applications that execute a durable run independently must own its
persisted state and reconnect/replay policy; losing an SSE subscriber does not
prove that the run failed. These defaults remain unchanged while deployment
limits are evaluated. The real-HTTP tests cover both the configured overflow
and keep-alive comment behavior.

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
The pinned semantic suite compares 44 historical boundary cases against
`@ag-ui/core@0.0.59`. Separately, `interop/` checks all 31 normative 1.0 event
variants against the TypeScript source in this checkout and exercises the five
retired thinking fixtures through Rust's compatibility codec.
The remaining typed representation difference is an explicit fixture expectation,
not a claim of lossless equivalence. See [protocol boundaries](docs/protocol-boundary.md).

The import excludes A2UI, live model tests, the standalone documentation site and
publishing workflows. JSON/SSE is implemented; the `protobuf` feature only exposes
an explicitly unsupported formatter and is not a working binary transport.

The monorepo-specific [publishing workflow](docs/publishing.md) is proposed
separately from the standalone release automation. It runs manually, defaults to
verification only, and can publish `ag-ui` from the official repository's `main`.
