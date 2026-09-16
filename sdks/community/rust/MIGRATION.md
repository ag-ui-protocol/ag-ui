# Proposed migration to `ag-ui`

This proposal adds `ag-ui` alongside the current community packages for review.
It does not remove packages, transfer ownership, publish versions, or deprecate
the existing API. The team and existing maintainers must agree on those steps.

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

The legacy example is `crates/ag-ui-client/examples/basic_agent.rs`. Its candidate
equivalent keeps a caller-chosen thread ID across turns:

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

Applications using subscriber-driven mutations need an explicit design review:
they may use `run_events` with their own reducer, or update the local thread
between runs. No compatibility adapter is promised by this proposal.

Creating a thread does not load server history. Snapshot restoration restores
local conversation state only. Aborting or dropping a client run stops local
consumption; it does not confirm cancellation of the remote business operation.

## Existing work

The proposal should be reviewed against the requirements in #2196 (string IDs),
#2208 (events), #2257 (multimodal content), #1407 (schema derives), #2500 (SSE
framing and overflow), and #972 (server, middleware and verification). The import
does not automatically close those PRs or assume every proposed feature is covered.

## Decisions before adoption or publishing

- Confirm the implementation and review/maintenance responsibilities with the team.
- Agree with @wdoppenberg on the existing `ag-ui-core` and `ag-ui-client` packages.
  A final informational release should preserve their existing API and behavior,
  link to migration instructions, and avoid silently replacing their implementation.
- Agree on `ag-ui` ownership, release version, publishing access and any trusted
  publisher configuration. The imported 0.4.2 version records provenance and must
  not be republished as an upstream release.
- Decide when legacy source may be removed. Its published versions remain available.
- Keep the feature-based `ag-ui` layout for this review. A core/client/server split
  is a separate decision; the `ag-ui-server` name currently belongs to a third party.

The standalone A2UI crate, website, personal skills and release automation are
outside this proposal. They do not need to move for the AG-UI SDK to be reviewed.
