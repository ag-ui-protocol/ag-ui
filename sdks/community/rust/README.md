# AG-UI Rust SDK

> **Status:** This is a community-contributed SDK that is not actively maintained. The versions
> published to crates.io (`ag-ui-core` v0.1.0, `ag-ui-client` v0.1.0) are outdated and missing
> types required by the client. To use this SDK, build from source against the workspace in this
> repository. See [ag-ui-protocol/ag-ui#243](https://github.com/ag-ui-protocol/ag-ui/pull/243)
> for the original contribution.

A Rust implementation of the [AG-UI protocol](https://docs.ag-ui.com), organized as a Cargo workspace with two crates:

- **[`ag-ui-core`](crates/ag-ui-core)** -- Core protocol types (events, messages, state, tools) implemented with `serde` for (de)serialization.
- **[`ag-ui-client`](crates/ag-ui-client)** -- HTTP client for connecting to AG-UI agent endpoints, designed to mirror the TypeScript client API.

## Building from source

```bash
cd sdks/community/rust
cargo build
```

## Running examples

```bash
cargo run --example <example_name>
```

See the [examples folder](crates/ag-ui-client/examples) and individual crate READMEs for more details.
