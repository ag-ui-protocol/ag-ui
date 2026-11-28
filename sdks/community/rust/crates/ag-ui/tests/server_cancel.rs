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
            ctx.cancellation_token().cancel();
            ctx.say("two")?;
            ctx.say("three")?;
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = Runner::new(Chatty).run(input()).collect().await;

    assert_eq!(text(&events), ["one"]);
    let Event::RunFinished(finished) = events.last().expect("a terminal event") else {
        panic!("expected RUN_FINISHED, got {:?}", events.last());
    };
    assert_eq!(finished.outcome, Some(RunOutcome::Cancelled));
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
        .collect()
        .await;

    assert_eq!(
        events.iter().map(Event::event_type).collect::<Vec<_>>(),
        [EventType::RunStarted, EventType::RunFinished]
    );
    let Event::RunFinished(finished) = events.last().unwrap() else {
        unreachable!()
    };
    assert_eq!(finished.outcome, Some(RunOutcome::Cancelled));
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

    let first = stream.next().await.expect("a first event");
    assert_eq!(first.event_type(), EventType::RunStarted);

    // The agent is parked inside `until_cancelled` by now.
    token.cancel();

    let rest: Vec<Event> = stream.collect().await;

    assert_eq!(text(&rest), ["working"]);
    let Event::RunFinished(finished) = rest.last().expect("a terminal event") else {
        panic!("expected RUN_FINISHED, got {:?}", rest.last());
    };
    assert_eq!(finished.outcome, Some(RunOutcome::Cancelled));
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
                ctx.cancellation_token().cancel();
            }
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = Runner::new(Polite).run(input()).collect().await;

    assert_eq!(text(&events), ["a"]);
    assert!(matches!(
        events.last(),
        Some(Event::RunFinished(finished)) if finished.outcome == Some(RunOutcome::Cancelled)
    ));
}

// ---- cancelling with something open ---------------------------------------
//
// AG-UI 1.0, "Cancelled runs": a producer MUST close what the run opened —
// messages, tool calls, steps, subagents — before the RUN_FINISHED that
// cancels it. The handles close on `Drop` even after cancellation, and the
// driver closes the subagents nothing else will.

/// Runs `agent` to the end and checks the stream ends `RUN_FINISHED`
/// cancelled, with nothing left open along the way.
async fn cancelled_run(agent: impl Agent<State = ()>) -> Vec<Event> {
    let events: Vec<Event> = Runner::new(agent).run(input()).collect().await;
    let Some(Event::RunFinished(finished)) = events.last() else {
        panic!("expected RUN_FINISHED, got {events:#?}");
    };
    assert_eq!(finished.outcome, Some(RunOutcome::Cancelled), "{events:#?}");
    // Replayed through a fresh verifier, so "well formed" does not rest on the
    // run's own verifier having been consulted.
    #[cfg(feature = "verify")]
    {
        let mut verifier = ag_ui::server::EventVerifier::new();
        for event in &events {
            verifier
                .observe(event)
                .unwrap_or_else(|error| panic!("{error}\n{events:#?}"));
        }
    }
    events
}

fn types(events: &[Event]) -> Vec<EventType> {
    events.iter().map(Event::event_type).collect()
}

#[tokio::test]
async fn cancelling_mid_message_closes_the_message_and_finishes_cancelled() {
    struct InterruptedMessage;

    impl Agent for InterruptedMessage {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let token = ctx.cancellation_token();
            let mut message = ctx.assistant_message()?;
            message.delta("partial")?;
            token.cancel();
            message.delta("never sent")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(InterruptedMessage).await;
    assert_eq!(text(&events), ["partial"]);
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn cancelling_mid_tool_call_closes_the_call_and_finishes_cancelled() {
    struct InterruptedCall;

    impl Agent for InterruptedCall {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let token = ctx.cancellation_token();
            let mut call = ctx.tool_call("search")?;
            call.args(r#"{"q":"#)?;
            token.cancel();
            call.args(r#""rust"}"#)?;
            call.result("never sent")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(InterruptedCall).await;
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn a_result_after_cancellation_closes_the_call_but_is_not_sent() {
    struct LateResult;

    impl Agent for LateResult {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let token = ctx.cancellation_token();
            let mut call = ctx.tool_call("search")?;
            call.args("{}")?;
            token.cancel();
            call.result("the answer")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(LateResult).await;
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn cancelling_mid_reasoning_closes_both_halves_and_finishes_cancelled() {
    struct InterruptedThought;

    impl Agent for InterruptedThought {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let token = ctx.cancellation_token();
            let mut reasoning = ctx.reasoning()?;
            reasoning.delta("first")?;
            token.cancel();
            reasoning.delta("second")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(InterruptedThought).await;
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ReasoningStart,
            EventType::ReasoningMessageStart,
            EventType::ReasoningMessageContent,
            EventType::ReasoningMessageEnd,
            EventType::ReasoningEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn cancelling_mid_step_closes_the_step_and_finishes_cancelled() {
    struct InterruptedStep;

    impl Agent for InterruptedStep {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let token = ctx.cancellation_token();
            let mut outer = ctx.step("plan")?;
            let mut inner = outer.step("search")?;
            inner.say("looking")?;
            token.cancel();
            inner.say("never sent")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(InterruptedStep).await;
    assert_eq!(text(&events), ["looking"]);
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::StepStarted,
            EventType::StepStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::StepFinished,
            EventType::StepFinished,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn cancelling_inside_a_subagent_closes_it_and_finishes_cancelled() {
    struct InterruptedSubagents;

    impl Agent for InterruptedSubagents {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let token = ctx.cancellation_token();
            let mut planner = ctx.subagent("planner")?;
            let mut estimator = planner.subagent("estimator")?;
            let mut message = estimator.assistant_message()?;
            message.delta("About a")?;
            token.cancel();
            message.delta(" day")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(InterruptedSubagents).await;
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::SubagentStarted,
            EventType::SubagentStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::SubagentError,
            EventType::SubagentError,
            EventType::RunFinished,
        ]
    );
    // Innermost first, and each one says why it ended. A cancelled
    // invocation neither succeeded nor is waiting, and an error naming the
    // cancellation is the only ending the schema has for that.
    let closed: Vec<(&str, Option<&str>)> = events
        .iter()
        .filter_map(|event| match event {
            Event::SubagentError(error) => {
                Some((error.subagent_run_id.as_str(), error.code.as_deref()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        closed,
        [
            ("r-sub-2", Some("CANCELLED")),
            ("r-sub-1", Some("CANCELLED"))
        ]
    );
}

#[tokio::test]
async fn a_subagent_can_still_be_closed_explicitly_after_cancellation() {
    struct ClosesItsOwn;

    impl Agent for ClosesItsOwn {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut worker = ctx.subagent("worker")?;
            worker.say("halfway")?;
            worker.cancellation_token().cancel();
            worker.fail_with_code("stopped by the user", "USER_STOP")?;
            ctx.check_cancelled()?;
            Ok(RunOutcome::Success)
        }
    }

    let events = cancelled_run(ClosesItsOwn).await;
    let errors: Vec<Option<&str>> = events
        .iter()
        .filter_map(|event| match event {
            Event::SubagentError(error) => Some(error.code.as_deref()),
            _ => None,
        })
        .collect();
    assert_eq!(errors, [Some("USER_STOP")], "closed once, by the agent");
}

#[tokio::test]
async fn an_agent_that_reports_cancelled_itself_has_its_subagents_closed_too() {
    struct StopsItself;

    impl Agent for StopsItself {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut worker = ctx.subagent("worker")?;
            worker.say("over budget")?;
            drop(worker);
            Ok(RunOutcome::Cancelled)
        }
    }

    let events = cancelled_run(StopsItself).await;
    assert_eq!(
        types(&events)[events.len() - 2..],
        [EventType::SubagentError, EventType::RunFinished]
    );
}

/// Without the `verify` feature too: the sink itself refuses anything after
/// the terminal event, so a run can never put events past its end on the wire.
#[tokio::test]
async fn nothing_is_sent_after_the_run_ended() {
    struct TalksPastTheEnd;

    impl Agent for TalksPastTheEnd {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::run_finished_success("t", "r"))?;
            let late = ctx.say("too late");
            assert!(late.is_err(), "an emit after RUN_FINISHED must fail");
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = Runner::new(TalksPastTheEnd).run(input()).collect().await;
    assert_eq!(
        types(&events),
        [EventType::RunStarted, EventType::RunFinished]
    );
}

#[tokio::test]
async fn dropping_the_stream_mid_run_disconnects_the_agent() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Waiting(Arc<AtomicBool>);
    struct DropMarker(Arc<AtomicBool>);

    impl Drop for DropMarker {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    impl Agent for Waiting {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let _guard = DropMarker(self.0.clone());
            ctx.say("waiting")?;
            std::future::pending().await
        }
    }

    let dropped = Arc::new(AtomicBool::new(false));
    let runner = Runner::new(Waiting(dropped.clone()));
    let mut stream = Box::pin(runner.run(input()));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let event = stream.next().await.expect("the waiting run must stay open");
            if matches!(event, Event::TextMessageContent(_)) {
                return;
            }
        }
    })
    .await
    .expect("the waiting agent should start streaming");
    assert!(!dropped.load(Ordering::SeqCst));
    drop(stream);
    assert!(
        dropped.load(Ordering::SeqCst),
        "the pending agent future was retained"
    );
}
