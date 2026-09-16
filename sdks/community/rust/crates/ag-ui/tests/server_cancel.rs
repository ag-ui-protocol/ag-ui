//! Cancellation stops a run, whether or not the agent thought about it.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, CancellationToken, Error, Result, RunContext, Runner};
use ag_ui::{Event, EventType, RunAgentInput, RunOutcome};
use futures_util::StreamExt as _;

fn input() -> RunAgentInput {
    RunAgentInput::new("t", "r")
}

fn text(events: &[Event]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            Event::TextMessageContent(payload) => Some(payload.delta.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn cancelling_mid_run_stops_the_agent_at_its_next_emit() {
    struct Chatty;

    impl Agent for Chatty {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("one")?;
            // Stand in for the transport noticing the client disconnected.
            ctx.cancel_token().cancel();
            ctx.say("two")?;
            ctx.say("three")?;
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = Runner::new(Chatty)
        .run(input())
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

    assert_eq!(text(&events), ["one"]);
    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("CANCELLED"));
}

#[tokio::test]
async fn a_run_cancelled_before_it_starts_emits_nothing_but_the_brackets() {
    struct Chatty;

    impl Agent for Chatty {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("never")?;
            Ok(RunOutcome::Success)
        }
    }

    let token = CancellationToken::new();
    token.cancel();

    let events: Vec<Event> = Runner::new(Chatty)
        .cancellation(token)
        .run(input())
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

    assert_eq!(
        events.iter().map(Event::event_type).collect::<Vec<_>>(),
        [EventType::RunStarted, EventType::RunError]
    );
}

#[tokio::test]
async fn cancellation_wakes_an_agent_that_is_waiting() {
    struct Waiter;

    impl Agent for Waiter {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("working")?;
            // A stand-in for a model call that never returns.
            let answer = ctx.until_cancelled(std::future::pending::<&str>()).await;
            assert!(answer.is_none(), "cancellation should have won the race");
            ctx.say("unreachable")?;
            Ok(RunOutcome::Success)
        }
    }

    let runner = Runner::new(Waiter);
    let token = runner.cancellation_token();
    let mut stream = Box::pin(runner.run(input()));

    let first = stream
        .next()
        .await
        .expect("a first event")
        .expect("no break");
    assert_eq!(first.event_type(), EventType::RunStarted);

    // The agent is parked inside `until_cancelled` by now.
    token.cancel();

    let rest: Vec<Event> = stream
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

    assert_eq!(text(&rest), ["working"]);
    let Event::RunError(error) = rest.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", rest.last());
    };
    assert_eq!(error.code.as_deref(), Some("CANCELLED"));
}

#[tokio::test]
async fn an_agent_can_check_cancellation_itself() {
    struct Polite;

    impl Agent for Polite {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            for chunk in ["a", "b", "c"] {
                if ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                ctx.say(chunk)?;
                ctx.cancel_token().cancel();
            }
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = Runner::new(Polite)
        .run(input())
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

    assert_eq!(text(&events), ["a"]);
}

#[tokio::test]
async fn dropping_the_stream_mid_run_disconnects_the_agent() {
    struct Chatty;

    impl Agent for Chatty {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            for chunk in ["a", "b", "c"] {
                ctx.say(chunk)?;
            }
            Ok(RunOutcome::Success)
        }
    }

    let mut stream = Box::pin(Runner::new(Chatty).run(input()));
    let first = stream
        .next()
        .await
        .expect("a first event")
        .expect("no break");
    assert_eq!(first.event_type(), EventType::RunStarted);
    drop(stream);
    // Nothing to assert beyond "this does not hang or panic": the agent's
    // future is dropped with the stream, so it simply stops being polled.
}
