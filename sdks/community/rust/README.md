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

`--local` reads `sdks/typescript/packages/core/src/events.ts` from this checkout.
It checks event names, payload field names and optionality, including inherited
base fields. It fails when schemas cannot be compared. This is not a complete
semantic conformance proof; the wire tests and cross-language checks complement it.
The pinned semantic suite compares 44 boundary cases against the published
`@ag-ui/core@0.0.59`, while `interop/` checks the same cases and all 36 event
variants against the TypeScript source in this checkout.
Two existing typed representation differences are explicit fixture expectations,
not a claim of lossless equivalence. See [protocol boundaries](docs/protocol-boundary.md).

The import excludes A2UI, live model tests, the standalone documentation site and
publishing workflows. JSON/SSE is implemented; the `protobuf` feature only exposes
an explicitly unsupported formatter and is not a working binary transport.
