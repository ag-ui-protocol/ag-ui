# Migrating to `ag-ui`

This guide covers moving from `ag-ui-core` and `ag-ui-client` to the proposed
single-crate `ag-ui` SDK. See [README.md](README.md#try-the-candidate) for dependency
setup while this branch is under review.

## API changes

Wire compatibility and Rust source compatibility are different. Changing a
dependency name or re-exporting the new types does not preserve the old API.

| Existing community SDK | Candidate `ag-ui` |
| --- | --- |
| `ag_ui_core::types::*` | Protocol types re-exported from `ag_ui` |
| UUID-backed `ThreadId`, `RunId`, `MessageId` | String-backed IDs accepting protocol IDs |
| `HttpAgent::builder().with_url_str(url)?.build()?` | `HttpAgent::new(url)?` or `HttpAgent::builder(url)` |
| `RunAgentParams` and `agent.run_agent(&params, subscribers)` | `agent.thread(id)`, then `thread.send(text)?` |
| `RunAgentResult.new_state` | `thread.state()` or `thread.raw_state()` |
| `RunAgentResult.new_messages` | `RunReport.new_messages` |
| `AgentSubscriber` callbacks | `RunStream` updates and a read-only `on_event` observer |
| Client-side `Agent` trait | `Transport` for custom clients; `server::Agent` is a different, server-side contract |

### A complete client run

The [existing client example](crates/ag-ui-client/examples/basic_agent.rs)
uses `run_agent(&params, subscribers)`. Its candidate equivalent keeps a
caller-chosen thread ID across turns:

```rust,no_run
use ag_ui::client::HttpAgent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let agent = HttpAgent::new("http://127.0.0.1:3001/")?;
    let mut thread = agent.thread("weather-chat");
    let report = thread.send("What is the temperature in Seoul?")?.collect_report().await;
    println!("Outcome: {:?}", report.end);
    println!("New messages: {:?}", report.new_messages);
    println!("State: {:?}", thread.raw_state());
    Ok(())
}
```

`collect_report()` returns a report, not a `Result` guaranteeing server success.
Inspect `RunEnd` and `diagnostics`; interrupted, failed and aborted runs are
distinct. `thread_with_state` provides a typed state view. The low-level
`run_events(input)` API remains available for applications that own their state.

### Subscribers are not drop-in compatible

The legacy subscriber can await work and return `AgentStateMutation`. The new
`on_event` callback is synchronous and read-only. It cannot replace a mutating
subscriber unchanged. Use it for logging; consume updates for UI work:

```rust,no_run
use ag_ui::client::{HttpAgent, Update};
use futures_util::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let agent = HttpAgent::new("http://127.0.0.1:3001/")?;
    let mut thread = agent.thread("weather-chat");
    thread.on_event(|event| println!("{}", event.event_type()));
    let mut run = thread.send("Hello")?;
    while let Some(update) = run.next().await {
        if let Update::Message(message) = update {
            println!("{:?}", message.message);
        }
    }
    Ok(())
}
```

For subscriber-driven mutations, use `run_events` with an application-owned
reducer, or update the local thread between runs. There is no drop-in subscriber
adapter.

## Behavior to account for

Creating a thread does not load server history. Snapshot restoration restores
local conversation state only. Aborting or dropping a client run stops local
consumption; it does not confirm cancellation of the remote business operation.

Consumers that need insertion-ordered JSON must enable `serde_json/preserve_order`
in their own dependency graph. Applications forwarding unknown event fields
should retain raw JSON; the typed event representation discards those extensions.
See [protocol boundaries](docs/protocol-boundary.md) for JSON decoding and
normalization details.

## Existing packages

The `ag-ui-core` and `ag-ui-client` source remains in this workspace, and their
previously published versions remain available.
The proposed final releases would preserve their existing APIs and link to this
guide. Release and ownership arrangements are tracked in the
[transition checklist](docs/transition.md).
