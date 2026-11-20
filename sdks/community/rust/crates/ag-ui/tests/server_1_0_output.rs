//! The hosted producer declares 1.0 and must not emit retired wire events.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, Result, RunContext, Runner};
use ag_ui::{Event, RunAgentInput, RunOutcome};
use futures_util::StreamExt;

struct RetiredThinking;

impl Agent for RetiredThinking {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        ctx.emit(serde_json::from_value(
            serde_json::json!({ "type": "THINKING_START" }),
        )?)?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn a_1_0_producer_rejects_retired_thinking_events() {
    let events: Vec<_> = Runner::new(RetiredThinking)
        .run(RunAgentInput::new("thread", "run"))
        .collect()
        .await;
    assert!(matches!(
        &events[0],
        Event::RunStarted(started) if started.protocol_version.as_deref() == Some("1.0")
    ));
    assert!(matches!(
        events.last(),
        Some(Event::RunError(error)) if error.code.as_deref() == Some("PROTOCOL")
    ));
    assert!(
        events
            .iter()
            .all(|event| !event.event_type().as_str().starts_with("THINKING_"))
    );
}

#[tokio::test]
async fn a_producer_rejects_duplicate_interrupt_ids_before_publishing_the_outcome() {
    struct DuplicateInterrupt;

    impl Agent for DuplicateInterrupt {
        type State = ();

        async fn run(&self, _: &mut RunContext<()>) -> Result<RunOutcome> {
            Ok(RunOutcome::interrupt(vec![
                ag_ui::Interrupt::new("i", "approval"),
                ag_ui::Interrupt::new("i", "confirmation"),
            ]))
        }
    }

    let events: Vec<_> = Runner::new(DuplicateInterrupt)
        .run(RunAgentInput::new("t", "r"))
        .collect()
        .await;
    assert!(
        matches!(events.as_slice(), [Event::RunStarted(_), Event::RunError(error)]
        if error.message.contains("more than once"))
    );
}
