//! Every run starts with `RUN_STARTED` and ends with exactly one of
//! `RUN_FINISHED` / `RUN_ERROR` — whatever the agent does or fails to do.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, Error, Result, RunContext, run};
use ag_ui::{Event, EventType, Interrupt, RunAgentInput, RunOutcome};
use futures_util::StreamExt as _;

async fn collect(agent: impl Agent, input: RunAgentInput) -> Vec<Event> {
    run(agent, input)
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await
}

fn input() -> RunAgentInput {
    RunAgentInput::new("thread-1", "run-1")
}

struct Idle;

impl Agent for Idle {
    type State = ();

    async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn an_agent_that_does_nothing_still_brackets_the_run() {
    let events = collect(Idle, input()).await;

    assert_eq!(
        events,
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::run_finished_success("thread-1", "run-1"),
        ]
    );
}

#[tokio::test]
async fn an_error_becomes_run_error_and_not_a_panic() {
    struct Broken;

    impl Agent for Broken {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("about to fail")?;
            Err(Error::agent("the weather service is down"))
        }
    }

    let events = collect(Broken, input()).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();

    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunError,
        ]
    );

    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("AGENT_ERROR"));
    assert!(
        error.message.contains("the weather service is down"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn failing_mid_message_closes_the_message_before_run_error() {
    // What a peer AG-UI server sends here is not settled: upstream's own client
    // verifier allows RUN_ERROR at any point — `client/src/verify/verify.ts`,
    // `case EventType.RUN_ERROR: // RUN_ERROR can happen at any time` — and the
    // Python integrations yield a bare RunErrorEvent out of an `except` block,
    // leaving whatever was open open. Our verifier exempts RUN_ERROR from the
    // open-at-finish rule so that stream is accepted from a peer.
    //
    // What we *emit* is the tidier end of that range, and not by choice: the
    // message handle closes itself on `Drop`, so the `?` that ends the run
    // unwinds through TEXT_MESSAGE_END on the way out. A client that tolerates
    // the bare form tolerates this one too, so the strict output is the safe
    // one to send.
    struct FailsMidSentence;

    impl Agent for FailsMidSentence {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut message = ctx.assistant_message()?;
            message.delta("half a sen")?;
            Err(Error::agent("the model hung up"))
        }
    }

    let events = collect(FailsMidSentence, input()).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();

    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunError,
        ],
        "the open message is closed on the way out, then the run reports"
    );
}

#[tokio::test]
async fn an_interrupt_outcome_rides_on_run_finished() {
    struct Asks;

    impl Agent for Asks {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("May I delete the file?")?;
            Ok(RunOutcome::interrupt(vec![Interrupt::new(
                "i-1",
                "tool_approval",
            )]))
        }
    }

    let events = collect(Asks, input()).await;
    let Event::RunFinished(finished) = events.last().expect("a terminal event") else {
        panic!("expected RUN_FINISHED, got {:?}", events.last());
    };

    assert_eq!(
        finished.outcome,
        Some(RunOutcome::interrupt(vec![Interrupt::new(
            "i-1",
            "tool_approval"
        )]))
    );
}

#[tokio::test]
async fn an_empty_interrupt_list_is_rejected_rather_than_shipped() {
    struct Empty;

    impl Agent for Empty {
        type State = ();

        async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            Ok(RunOutcome::Interrupt {
                interrupts: Vec::new(),
            })
        }
    }

    let events = collect(Empty, input()).await;
    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("PROTOCOL"));
}

#[tokio::test]
async fn a_resuming_request_reaches_the_agent() {
    struct Resumes;

    impl Agent for Resumes {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            assert!(ctx.is_resume());
            let answer = ctx.resume_for("i-1").expect("the answer to i-1");
            assert_eq!(answer.status, ag_ui::ResumeStatus::Resolved);
            ctx.say("Deleted.")?;
            Ok(RunOutcome::Success)
        }
    }

    let mut input = input();
    input.resume = Some(vec![ag_ui::ResumeEntry::resolved(
        "i-1",
        serde_json::json!(true),
    )]);

    let events = collect(Resumes, input).await;
    assert_eq!(events.len(), 5, "{events:#?}");
}

#[tokio::test]
async fn an_agent_that_ends_the_run_itself_is_not_terminated_twice() {
    struct EndsItself;

    impl Agent for EndsItself {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::run_error("I will report this myself"))?;
            Ok(RunOutcome::Success)
        }
    }

    let events = collect(EndsItself, input()).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(types, [EventType::RunStarted, EventType::RunError]);
}

#[tokio::test]
async fn the_agent_sees_the_whole_request() {
    struct Inspects;

    impl Agent for Inspects {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            assert_eq!(ctx.thread_id().as_str(), "thread-1");
            assert_eq!(ctx.run_id().as_str(), "run-1");
            assert_eq!(ctx.messages().len(), 1);
            assert_eq!(ctx.tools().len(), 1);
            assert!(ctx.tool("search").is_some());
            assert_eq!(ctx.context().len(), 1);
            assert_eq!(ctx.forwarded_props()["tenant"], "acme");
            Ok(RunOutcome::Success)
        }
    }

    let mut input = input();
    input.messages = vec![ag_ui::Message::user("m-1", "hello")];
    input.tools = vec![ag_ui::Tool::new(
        "search",
        "Search the web",
        serde_json::json!({"type": "object"}),
    )];
    input.context = vec![ag_ui::Context::new("page", "/invoices")];
    input.forwarded_props = serde_json::json!({"tenant": "acme"});

    collect(Inspects, input).await;
}

#[test]
fn the_run_stream_is_send_and_static() {
    // What a transport needs to hand it to `axum::response::Sse`. Asserted
    // here so a change to the driver cannot quietly take it away.
    fn assert_send_static<T: Send + 'static>(_value: T) {}
    assert_send_static(run(Idle, input()));
}

#[tokio::test]
async fn a_boxed_agent_runs_like_any_other() {
    let agent: ag_ui::server::BoxAgent<()> = Box::new(Idle);
    let events = collect(agent, input()).await;
    assert_eq!(events.len(), 2);
}

#[tokio::test]
async fn a_shared_agent_runs_like_any_other() {
    let agent = std::sync::Arc::new(Idle);
    let events = collect(agent.clone(), input()).await;
    assert_eq!(events.len(), 2);
    // …and the original is still usable.
    assert_eq!(collect(agent, input()).await.len(), 2);
}
