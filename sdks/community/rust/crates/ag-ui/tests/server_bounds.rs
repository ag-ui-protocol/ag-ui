//! Bounded queues fail explicitly without losing the accepted event prefix.

#![cfg(feature = "server")]

use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ag_ui::server::{Agent, Error, Result, RunContext, Runner, StreamTransformer};
use ag_ui::{Event, EventType, RunAgentInput, RunOutcome};
use futures_util::StreamExt as _;

fn capacity(value: usize) -> NonZeroUsize {
    NonZeroUsize::new(value).unwrap()
}

fn assert_overflow(events: &[Event], limit: usize) {
    assert_eq!(events.len(), limit + 1);
    assert_eq!(events[0].event_type(), EventType::RunStarted);
    let Event::RunError(error) = events.last().unwrap() else {
        panic!("expected a terminal error");
    };
    assert_eq!(error.code.as_deref(), Some("EVENT_BUFFER_FULL"));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, Event::RunError(_)))
            .count(),
        1
    );
}

struct Burst;

impl Agent for Burst {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let mut message = ctx.assistant_message()?;
        for _ in 0..10_000 {
            message.delta("chunk")?;
        }
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn overflow_ends_an_open_message_once_even_when_its_guard_drops() {
    let events: Vec<_> = Runner::new(Burst)
        .event_buffer_capacity(capacity(8))
        .run(RunAgentInput::new("t", "r"))
        .map(Result::unwrap)
        .collect()
        .await;
    assert_overflow(&events, 8);
    assert_eq!(events[1].event_type(), EventType::TextMessageStart);
    assert!(
        events[2..8]
            .iter()
            .all(|event| event.event_type() == EventType::TextMessageContent)
    );
}

#[tokio::test]
async fn ignored_overflow_then_pending_does_not_keep_the_stream_or_agent_alive() {
    struct IgnoresError(Arc<AtomicBool>);
    impl Drop for IgnoresError {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    impl Agent for IgnoresError {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let error = ctx.say("fills the queue").unwrap_err();
            assert!(matches!(error, Error::EventBufferFull { capacity: 1 }));
            for _ in 0..1000 {
                assert!(ctx.say("must not accumulate").is_err());
            }
            std::future::pending().await
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let stream = Runner::new(IgnoresError(dropped.clone()))
        .event_buffer_capacity(capacity(1))
        .run(RunAgentInput::new("t", "r"));
    let events: Vec<_> =
        tokio::time::timeout(Duration::from_secs(1), stream.map(Result::unwrap).collect())
            .await
            .expect("the overflow must close the stream");
    assert_overflow(&events, 1);
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn capacity_applies_after_transformers_and_the_error_cannot_be_filtered_out() {
    struct Expander;
    impl StreamTransformer for Expander {
        fn transform(&mut self, event: Event) -> Vec<Event> {
            match event {
                Event::TextMessageContent(_) => vec![event; 100],
                Event::RunError(_) => vec![],
                _ => vec![event],
            }
        }
    }
    let events: Vec<_> = Runner::new(Burst)
        .transformer(Expander)
        .event_buffer_capacity(capacity(6))
        .run(RunAgentInput::new("t", "r"))
        .map(Result::unwrap)
        .collect()
        .await;
    assert_overflow(&events, 6);
}

#[tokio::test]
async fn draining_between_bursts_reuses_capacity_instead_of_limiting_total_events() {
    struct Paced;
    impl Agent for Paced {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            for _ in 0..20 {
                ctx.say("message")?;
                tokio::task::yield_now().await;
            }
            Ok(RunOutcome::Success)
        }
    }
    let events: Vec<_> = Runner::new(Paced)
        .event_buffer_capacity(capacity(4))
        .run(RunAgentInput::new("t", "r"))
        .map(Result::unwrap)
        .collect()
        .await;
    assert_eq!(events.len(), 62);
    assert_eq!(events.last().unwrap().event_type(), EventType::RunFinished);
}
