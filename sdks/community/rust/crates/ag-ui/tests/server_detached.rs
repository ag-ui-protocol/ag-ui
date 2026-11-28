//! A run taken as its two halves, and a run carried on by a second driver:
//! everything `Runner::run` guarantees holds without the stream that joins
//! them.

#![cfg(feature = "server")]

use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use ag_ui::server::{
    Agent, Error, EventReceiver, FilterToolCalls, Result, RunContext, Runner, ToolResultToState,
};
use ag_ui::{
    AssistantMessage, Event, EventType, Interrupt, Message, RunAgentInput, RunFinishedEvent,
    RunOutcome, RunStartedEvent, TextMessageRole, ToolCall,
};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;

fn input() -> RunAgentInput {
    RunAgentInput::new("t", "r")
}

fn types(events: &[Event]) -> Vec<EventType> {
    events.iter().map(Event::event_type).collect()
}

/// Polls `future` once, on no executor at all.
fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let waker = futures_util::task::noop_waker();
    future.poll(&mut Context::from_waker(&waker))
}

/// Uses every typed emitter once.
struct Busy;

impl Agent for Busy {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let mut step = ctx.step("work")?;
        step.think("What is asked?")?;
        let said = step.say("Looking it up.")?;
        let start = ag_ui::ToolCallStartEvent::new(step.new_tool_call_id(), "search")
            .with_parent_message_id(said);
        step.tool_call_with(start)?.result("3 results")?;
        let mut helper = step.subagent("helper")?;
        helper.say("Summarised.")?;
        helper.finish()?;
        drop(step);
        ctx.set_result(json!({ "found": 3 }));
        Ok(RunOutcome::Success)
    }
}

struct Fails;

impl Agent for Fails {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let mut message = ctx.assistant_message()?;
        message.delta("about to fail")?;
        Err(Error::agent("the model went away"))
    }
}

struct Pauses;

impl Agent for Pauses {
    type State = ();

    async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        Ok(RunOutcome::interrupt(vec![Interrupt::new(
            "ok", "approval",
        )]))
    }
}

/// The run read through its halves, with the driver on another task.
async fn detached<A: Agent + 'static>(runner: Runner<A>) -> Vec<Event> {
    let (driver, events) = runner.into_parts(input());
    let run = tokio::spawn(driver);
    let events: Vec<Event> = events.collect().await;
    run.await.expect("the driver does not panic");
    events
}

#[tokio::test]
async fn the_halves_carry_the_run_the_stream_carries() {
    let whole: Vec<Event> = Runner::new(Busy).run(input()).collect().await;
    assert_eq!(detached(Runner::new(Busy)).await, whole);
    assert_eq!(whole.first().unwrap().event_type(), EventType::RunStarted);
    assert_eq!(whole.last().unwrap().event_type(), EventType::RunFinished);

    let failed: Vec<Event> = Runner::new(Fails).run(input()).collect().await;
    assert_eq!(detached(Runner::new(Fails)).await, failed);
    assert_eq!(
        types(&failed),
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunError,
        ],
        "the handle still closed its message, and one terminal event followed"
    );

    let paused: Vec<Event> = Runner::new(Pauses).run(input()).collect().await;
    assert_eq!(detached(Runner::new(Pauses)).await, paused);

    let filter = || FilterToolCalls::deny(["search"]);
    let filtered: Vec<Event> = Runner::new(Busy)
        .transformer(filter())
        .run(input())
        .collect()
        .await;
    assert_eq!(
        detached(Runner::new(Busy).transformer(filter())).await,
        filtered
    );
    assert!(
        !types(&filtered).contains(&EventType::ToolCallStart),
        "the chain is the runner's, whichever way the run is taken"
    );
}

#[test]
fn the_agent_advances_with_nobody_reading_and_no_runtime() {
    let (driver, mut events) = Runner::new(Busy).into_parts(input());
    let mut driver = Box::pin(driver);
    assert_eq!(
        events.drain(),
        [],
        "nothing happens until the driver is polled"
    );

    // No executor, no reader: the driver is a plain future.
    assert_eq!(poll_once(driver.as_mut()), Poll::Ready(()));

    let events = events.drain();
    assert_eq!(events.first().unwrap().event_type(), EventType::RunStarted);
    let terminals = events
        .iter()
        .filter(|event| matches!(event, Event::RunFinished(_) | Event::RunError(_)))
        .count();
    assert_eq!(terminals, 1);
    let Some(Event::RunFinished(finished)) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(finished.result, Some(json!({ "found": 3 })));
}

/// Opens a message, says one thing, and waits for something that never
/// comes: a process that stops in the middle of a run.
struct Stalls;

impl Agent for Stalls {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let mut message = ctx.assistant_message()?;
        message.delta("Hello")?;
        std::future::pending::<()>().await;
        message.end()?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn cancelling_ends_a_detached_run_with_what_it_opened_closed() {
    /// Waits, mid-message, for something only cancellation interrupts.
    struct Listens;
    impl Agent for Listens {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let cancelled = ctx.cancelled();
            let mut message = ctx.assistant_message()?;
            message.delta("Hello")?;
            cancelled.await;
            message.delta("never sent")?;
            Ok(RunOutcome::Success)
        }
    }

    let runner = Runner::new(Listens);
    let token = runner.cancellation_token();
    let (driver, mut events) = runner.into_parts(input());
    let run = tokio::spawn(driver);
    let mut before = Vec::new();
    for _ in 0..3 {
        before.push(events.next().await.expect("the run is under way"));
    }
    assert_eq!(
        before.last().unwrap().event_type(),
        EventType::TextMessageContent
    );

    // Nobody is reading the response this run began in. The token is how it
    // is stopped.
    token.cancel();
    let rest: Vec<Event> = events.collect().await;
    run.await.expect("the driver ran to completion");
    assert_eq!(
        types(&rest),
        [EventType::TextMessageEnd, EventType::RunFinished]
    );
    let Some(Event::RunFinished(finished)) = rest.last() else {
        unreachable!()
    };
    assert_eq!(finished.outcome, Some(RunOutcome::Cancelled));
}

#[tokio::test]
async fn a_driver_dropped_before_it_finishes_leaves_no_terminal_event() {
    let (driver, mut events) = Runner::new(Stalls).into_parts(input());
    let mut driver = Box::pin(driver);
    assert!(poll_once(driver.as_mut()).is_pending());
    assert_eq!(events.drain().len(), 3);

    // The handle closes its message on the way out. Nothing is left to emit
    // the terminal event: that is the driver's, after the agent returns.
    drop(driver);
    let rest: Vec<Event> = events.collect().await;
    assert_eq!(types(&rest), [EventType::TextMessageEnd]);
}

#[tokio::test]
async fn an_overflow_ends_the_receiver_while_the_driver_is_still_pending() {
    struct IgnoresError(Arc<AtomicBool>);
    impl Drop for IgnoresError {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    impl Agent for IgnoresError {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            assert!(ctx.say("fills the queue").is_err());
            std::future::pending().await
        }
    }

    let dropped = Arc::new(AtomicBool::new(false));
    let (driver, events) = Runner::new(IgnoresError(dropped.clone()))
        .event_buffer_capacity(NonZeroUsize::new(1).unwrap())
        .into_parts(input());
    let run = tokio::spawn(driver);

    let events: Vec<Event> = tokio::time::timeout(Duration::from_secs(1), events.collect())
        .await
        .expect("the overflow closes the receiver");
    assert_eq!(types(&events), [EventType::RunStarted, EventType::RunError]);
    let Some(Event::RunError(error)) = events.last() else {
        unreachable!()
    };
    assert_eq!(error.code.as_deref(), Some("EVENT_BUFFER_FULL"));

    // What the joined stream does on its own, and the caller of the halves
    // has to: the receiver ended, the driver has not.
    assert!(!run.is_finished());
    assert!(!dropped.load(Ordering::SeqCst));
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_dropped_receiver_unwinds_the_agent() {
    struct Talks;
    impl Agent for Talks {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            loop {
                ctx.say("anyone?")?;
                tokio::task::yield_now().await;
            }
        }
    }
    let (driver, mut events) = Runner::new(Talks).into_parts(input());
    let run = tokio::spawn(driver);
    assert_eq!(
        events.next().await.map(|event| event.event_type()),
        Some(EventType::RunStarted)
    );
    drop(events);
    tokio::time::timeout(Duration::from_secs(1), run)
        .await
        .expect("the next emit fails, and `?` ends the agent")
        .expect("the driver does not panic");
}

// ---- a run carried on by a second driver --------------------------------

/// What a first driver sent before it stopped, and the receiver it left.
fn stopped_mid_run<A: Agent>(runner: Runner<A>, input: RunAgentInput) -> Vec<Event> {
    let (driver, mut events) = runner.into_parts(input);
    let mut driver = Box::pin(driver);
    assert!(poll_once(driver.as_mut()).is_pending(), "the agent stalls");
    // The process is gone: nothing unwinds, nothing is closed.
    std::mem::forget(driver);
    events.drain()
}

async fn continued<A: Agent + 'static>(
    runner: Runner<A>,
    input: RunAgentInput,
    sent: &[Event],
) -> Vec<Event> {
    let (driver, events) = runner
        .continue_run(input, sent)
        .expect("there is a run to continue");
    let run = tokio::spawn(driver);
    let events: Vec<Event> = events.collect().await;
    run.await.expect("the driver does not panic");
    events
}

/// Closes the message the first driver left open, by id, and goes on with
/// the typed emitters.
struct Finishes;

impl Agent for Finishes {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.emit(Event::text_message_content("r-msg-1", " world"))?;
        ctx.emit(Event::text_message_end("r-msg-1"))?;
        ctx.say("And another thing.")?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn a_continuation_sends_no_run_started_and_exactly_one_terminal_event() {
    let sent = stopped_mid_run(Runner::new(Stalls), input());
    assert_eq!(
        sent,
        [
            Event::run_started("t", "r"),
            Event::text_message_start("r-msg-1", TextMessageRole::Assistant),
            Event::text_message_content("r-msg-1", "Hello"),
        ]
    );

    let rest = continued(Runner::new(Finishes), input(), &sent).await;
    assert_eq!(
        rest,
        [
            Event::text_message_content("r-msg-1", " world"),
            Event::text_message_end("r-msg-1"),
            // The context counts on: `r-msg-1` is the message it continued.
            Event::text_message_start("r-msg-2", TextMessageRole::Assistant),
            Event::text_message_content("r-msg-2", "And another thing."),
            Event::text_message_end("r-msg-2"),
            Event::run_finished_success("t", "r"),
        ]
    );

    // The two parts are one run to whoever reads them.
    let run = [sent, rest].concat();
    #[cfg(feature = "client")]
    ag_ui::client::verify_all(&run).expect("one well-formed run");
    #[cfg(feature = "verify")]
    ag_ui::server::EventVerifier::new()
        .replay(&run)
        .expect("one well-formed run");
    let _ = run;
}

#[tokio::test]
async fn what_the_first_driver_left_open_has_to_be_closed() {
    struct Forgets;
    impl Agent for Forgets {
        type State = ();
        async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            Ok(RunOutcome::Success)
        }
    }
    let sent = stopped_mid_run(Runner::new(Stalls), input());
    let rest = continued(Runner::new(Forgets), input(), &sent).await;
    let [Event::RunError(error)] = rest.as_slice() else {
        panic!("{rest:?}");
    };
    assert_eq!(error.code.as_deref(), Some("PROTOCOL_VIOLATION"));
    assert!(error.message.contains("r-msg-1"), "{}", error.message);
}

#[derive(Default, Serialize, Deserialize)]
struct Draft {
    revision: u32,
    notes: String,
}

#[tokio::test]
async fn a_continuation_publishes_state_against_what_the_client_holds() {
    struct Drafts;
    impl Agent for Drafts {
        type State = Draft;
        async fn run(&self, ctx: &mut RunContext<Draft>) -> Result<RunOutcome> {
            ctx.update_state(|draft| {
                draft.revision = 1;
                draft.notes = "a document long enough that a patch is the smaller way".into();
            })?;
            std::future::pending().await
        }
    }
    struct Revises;
    impl Agent for Revises {
        type State = Draft;
        async fn run(&self, ctx: &mut RunContext<Draft>) -> Result<RunOutcome> {
            // The input carries the state as it stands, and the agent reads
            // it as its own.
            assert_eq!(ctx.state().revision, 1);
            ctx.update_state(|draft| draft.revision = 2)?;
            Ok(RunOutcome::Success)
        }
    }

    let sent = stopped_mid_run(Runner::new(Drafts), input());
    let Some(Event::StateSnapshot(published)) = sent.last() else {
        panic!("{sent:?}");
    };
    let mut request = input();
    request.state = published.snapshot.clone();

    let rest = continued(Runner::new(Revises), request, &sent).await;
    assert_eq!(
        rest[0],
        Event::state_delta(vec![ag_ui::PatchOperation::replace("/revision", 2)]),
        "a delta against the snapshot the first driver sent, not a second snapshot"
    );
}

#[tokio::test]
async fn a_subagent_left_active_is_the_continuation_s_to_close() {
    struct Delegates;
    impl Agent for Delegates {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut helper = ctx.subagent("helper")?;
            helper.say("On it.")?;
            std::future::pending().await
        }
    }
    let sent = stopped_mid_run(Runner::new(Delegates), input());
    assert_eq!(sent[1].event_type(), EventType::SubagentStarted);

    // Left active, the run cannot finish: with or without the verifier.
    struct Forgets;
    impl Agent for Forgets {
        type State = ();
        async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            Ok(RunOutcome::Success)
        }
    }
    let rest = continued(Runner::new(Forgets), input(), &sent).await;
    let [Event::RunError(error)] = rest.as_slice() else {
        panic!("{rest:?}");
    };
    assert!(error.message.contains("r-sub-1"), "{}", error.message);

    // Closed by id, it can, and a new subagent gets the next id.
    struct Closes;
    impl Agent for Closes {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::subagent_finished_success("r-sub-1"))?;
            ctx.subagent("second")?.finish()?;
            Ok(RunOutcome::Success)
        }
    }
    let rest = continued(Runner::new(Closes), input(), &sent).await;
    assert_eq!(
        rest,
        [
            Event::subagent_finished_success("r-sub-1"),
            Event::subagent_started("r-sub-2", "second"),
            Event::subagent_finished_success("r-sub-2"),
            Event::run_finished_success("t", "r"),
        ]
    );

    // A cancelled continuation closes it as a cancelled run does.
    struct Checks;
    impl Agent for Checks {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.check_cancelled()?;
            Ok(RunOutcome::Success)
        }
    }
    let runner = Runner::new(Checks);
    runner.cancellation_token().cancel();
    let rest = continued(runner, input(), &sent).await;
    assert_eq!(
        types(&rest),
        [EventType::SubagentError, EventType::RunFinished]
    );
}

#[tokio::test]
async fn a_continuation_answers_a_call_the_history_made_and_filters_as_configured() {
    // The request's history: an earlier run asked for a search.
    let mut request = input();
    request.messages = vec![Message::Assistant(AssistantMessage {
        id: "m0".into(),
        tool_calls: Some(vec![ToolCall::new("c0", "search", "{}")]),
        ..Default::default()
    })];
    // The first driver answered it. Replaying that needs the history first.
    let sent = [
        Event::run_started("t", "r"),
        Event::tool_call_result("m1", "c0", "3 results"),
    ];

    struct Calls;
    impl Agent for Calls {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.tool_call("internal_debug")?.result("hidden")?;
            ctx.tool_call("search")?.result("shown")?;
            Ok(RunOutcome::Success)
        }
    }
    let runner = Runner::new(Calls).transformer(FilterToolCalls::deny(["internal_debug"]));
    let rest = continued(runner, request, &sent).await;
    assert_eq!(
        types(&rest),
        [
            EventType::ToolCallStart,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::RunFinished,
        ]
    );
    let Event::ToolCallStart(shown) = &rest[0] else {
        unreachable!()
    };
    assert_eq!(shown.tool_call_name, "search");
}

#[tokio::test]
async fn the_run_continued_is_the_last_one_the_events_start() {
    // The stream's history: an earlier run, which failed with a subagent
    // active. Then the run the first driver left.
    let earlier = [
        Event::run_started("t", "earlier"),
        Event::subagent_started("helper", "helper"),
        Event::run_error("it failed"),
    ];
    let left = stopped_mid_run(Runner::new(Stalls), input());
    let sent = [earlier.as_slice(), left.as_slice()].concat();

    // What the earlier run left active ended with it, and is not this run's
    // to close.
    let rest = continued(Runner::new(Finishes), input(), &sent).await;
    assert_eq!(rest.last(), Some(&Event::run_finished_success("t", "r")));
    #[cfg(feature = "verify")]
    ag_ui::server::EventVerifier::new()
        .replay(&[sent.as_slice(), rest.as_slice()].concat())
        .expect("two runs in sequence, each well formed");

    // The input names the run that is continued, not one before it.
    let other = refusal(RunAgentInput::new("t", "earlier"), &sent);
    assert!(matches!(other, Error::Protocol(_)), "{other}");

    // Between two runs there is none to continue, whichever is named.
    for named in ["earlier", "r"] {
        let between = refusal(RunAgentInput::new("t", named), &earlier);
        let Error::Verification(error) = &between else {
            panic!("{between}");
        };
        assert_eq!(error.rule, ag_ui::server::Rule::RunEnded);
    }
}

// ---- what a continuation inherits ---------------------------------------

/// The first driver stopped half way through the arguments of a call.
fn stopped_mid_call() -> [Event; 3] {
    [
        Event::run_started("t", "r"),
        Event::tool_call_start("c1", "search"),
        Event::tool_call_args("c1", r#"{"q":"#),
    ]
}

/// Finishes the call the first driver left open, and answers it.
struct FinishesTheCall;

impl Agent for FinishesTheCall {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.emit(Event::tool_call_args("c1", r#""rust"}"#))?;
        ctx.emit(Event::tool_call_end("c1"))?;
        ctx.emit(Event::tool_call_result("m1", "c1", "1 hit"))?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn a_filter_lets_a_continuation_finish_a_call_it_has_nothing_against() {
    let sent = stopped_mid_call();
    let whole = [
        Event::tool_call_args("c1", r#""rust"}"#),
        Event::tool_call_end("c1"),
        Event::tool_call_result("m1", "c1", "1 hit"),
        Event::run_finished_success("t", "r"),
    ];
    assert_eq!(
        continued(Runner::new(FinishesTheCall), input(), &sent).await,
        whole
    );

    // The filter did not see the call start: the driver before this one
    // did. It is told what was sent, and judges the call by its name.
    for filter in [
        FilterToolCalls::deny(["internal_debug"]),
        FilterToolCalls::allow(["search"]),
    ] {
        let runner = Runner::new(FinishesTheCall).transformer(filter);
        assert_eq!(continued(runner, input(), &sent).await, whole);
    }
}

/// What each emit of an agent returned, for a test to read afterwards.
type Outcomes = Arc<Mutex<Vec<std::result::Result<(), String>>>>;

/// Emits each event, recording what the emit returned, and carries on.
struct Reports {
    events: Vec<Event>,
    outcomes: Outcomes,
}

impl Agent for Reports {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        for event in &self.events {
            let outcome = ctx.emit(event.clone()).map_err(|error| error.to_string());
            self.outcomes.lock().unwrap().push(outcome);
        }
        Ok(RunOutcome::Success)
    }
}

/// A filter that never saw a call start cannot tell it from a call that was
/// filtered where it could not see. What belongs to the call is dropped, as
/// the call was, and the emit returns `Ok`.
#[tokio::test]
async fn an_event_for_a_call_a_filter_never_saw_start_is_dropped() {
    // The call is not among the events sent, and not in the history: what a
    // call the first driver's filter dropped looks like from here.
    let sent = [Event::run_started("t", "r")];
    let unknown = vec![
        Event::tool_call_args("c9", r#"{"dump":true}"#),
        Event::tool_call_end("c9"),
        Event::tool_call_result("m9", "c9", "everything"),
        Event::reasoning_encrypted_value(
            ag_ui::ReasoningEncryptedValueSubtype::ToolCall,
            "c9",
            "opaque",
        ),
        Event::tool_call_chunk(Some("c9".into()), None, Some("more".into())),
        Event::tool_call_chunk(None, None, Some("and more".into())),
    ];

    for filter in [
        FilterToolCalls::deny(["internal_debug"]),
        FilterToolCalls::allow(["search"]),
    ] {
        let outcomes = Outcomes::default();
        let agent = Reports {
            events: unknown.clone(),
            outcomes: Arc::clone(&outcomes),
        };
        let rest = continued(Runner::new(agent).transformer(filter), input(), &sent).await;
        assert_eq!(
            rest,
            [Event::run_finished_success("t", "r")],
            "nothing of the call is sent"
        );
        assert_eq!(*outcomes.lock().unwrap(), vec![Ok(()); unknown.len()]);
    }
}

/// The first driver's filter removed a call it started, and the run stopped
/// before the call ended. The call is not among the events sent. The
/// continuation finishes and answers it, is told nothing went wrong, and
/// nothing of the call is sent.
#[tokio::test]
async fn a_continuation_finishes_a_call_the_first_driver_s_filter_removed() {
    struct StartsADeniedCall;
    impl Agent for StartsADeniedCall {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::tool_call_start("c9", "internal_debug"))?;
            ctx.emit(Event::tool_call_args("c9", r#"{"dump":"#))?;
            std::future::pending().await
        }
    }
    let finishing = vec![
        Event::tool_call_args("c9", "true}"),
        Event::tool_call_end("c9"),
        Event::tool_call_result("m9", "c9", "everything"),
    ];

    for filter in [
        FilterToolCalls::deny(["internal_debug"]),
        FilterToolCalls::allow(["search"]),
    ] {
        let first = Runner::new(StartsADeniedCall).transformer(filter.clone());
        let sent = stopped_mid_run(first, input());
        assert_eq!(sent, [Event::run_started("t", "r")]);

        let outcomes = Outcomes::default();
        let agent = Reports {
            events: finishing.clone(),
            outcomes: Arc::clone(&outcomes),
        };
        let rest = continued(Runner::new(agent).transformer(filter), input(), &sent).await;
        assert_eq!(rest, [Event::run_finished_success("t", "r")]);
        assert_eq!(*outcomes.lock().unwrap(), vec![Ok(()); finishing.len()]);
    }
}

/// The call the first driver left open, streamed by chunks: it opened the
/// call with a chunk that names the call and the tool. The continuation
/// names the call on its first chunk and goes on with chunks that name no
/// id, as within any single run, and all of it goes out with the call.
#[tokio::test]
async fn a_filter_lets_a_continuation_finish_a_chunked_call_whose_first_chunk_names_it() {
    let sent = [
        Event::run_started("t", "r"),
        Event::tool_call_chunk(
            Some("c1".into()),
            Some("search".into()),
            Some(r#"{"q":"#.into()),
        ),
    ];
    let finishing = vec![
        Event::tool_call_chunk(Some("c1".into()), None, Some(r#""ru"#.into())),
        Event::tool_call_chunk(None, None, Some(r#"st""#.into())),
        Event::tool_call_chunk(None, None, Some("}".into())),
        Event::tool_call_result("m1", "c1", "1 hit"),
    ];
    let mut whole = finishing.clone();
    whole.push(Event::run_finished_success("t", "r"));

    for filter in [
        None,
        Some(FilterToolCalls::deny(["internal_debug"])),
        Some(FilterToolCalls::allow(["search"])),
    ] {
        let outcomes = Outcomes::default();
        let agent = Reports {
            events: finishing.clone(),
            outcomes: Arc::clone(&outcomes),
        };
        let mut runner = Runner::new(agent);
        if let Some(filter) = filter {
            runner = runner.transformer(filter);
        }
        let rest = continued(runner, input(), &sent).await;
        assert_eq!(rest, whole);
        assert_eq!(*outcomes.lock().unwrap(), vec![Ok(()); finishing.len()]);

        // A client reads one call, assembled from both drivers' chunks.
        #[cfg(feature = "client")]
        {
            let run = [sent.as_slice(), rest.as_slice()].concat();
            ag_ui::client::verify_all(&run).expect("one well-formed run");
            let expanded = ag_ui::client::normalize_all(run).expect("normalizes");
            let args: String = expanded
                .iter()
                .filter_map(|event| match event {
                    Event::ToolCallArgs(args) => Some(args.delta.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(args, r#"{"q":"rust"}"#);
        }
    }
}

/// The first driver streamed two calls by chunks in one lane, and its filter
/// removed the second. The events sent leave the first call's stream open
/// and say nothing of the second, so a chunk of the continuation that names
/// no id may be meant for either: it is dropped, and so are the chunks that
/// follow one naming the removed call. None of them reaches the wire or the
/// arguments of the call that was sent, and each emit returns `Ok`. A chunk
/// naming the call that was sent takes it up again.
#[tokio::test]
async fn a_chunk_that_names_no_id_does_not_continue_what_the_first_driver_left_open() {
    struct StreamsTwoCalls;
    impl Agent for StreamsTwoCalls {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::tool_call_chunk(
                Some("c1".into()),
                Some("search".into()),
                Some("A".into()),
            ))?;
            ctx.emit(Event::tool_call_chunk(
                Some("c2".into()),
                Some("internal_debug".into()),
                Some("B".into()),
            ))?;
            std::future::pending().await
        }
    }
    let chunk = |id: Option<&str>, delta: &str| {
        Event::tool_call_chunk(id.map(ag_ui::ToolCallId::new), None, Some(delta.into()))
    };

    let filter = FilterToolCalls::deny(["internal_debug"]);
    let first = Runner::new(StreamsTwoCalls).transformer(filter.clone());
    let sent = stopped_mid_run(first, input());
    assert_eq!(
        sent,
        [
            Event::run_started("t", "r"),
            Event::tool_call_chunk(Some("c1".into()), Some("search".into()), Some("A".into())),
        ]
    );

    let continuing = vec![
        chunk(None, "C"),
        chunk(Some("c2"), "D"),
        chunk(None, "E"),
        chunk(Some("c1"), "F"),
        chunk(None, "G"),
    ];
    let outcomes = Outcomes::default();
    let agent = Reports {
        events: continuing.clone(),
        outcomes: Arc::clone(&outcomes),
    };
    let rest = continued(Runner::new(agent).transformer(filter), input(), &sent).await;
    assert_eq!(
        rest,
        [
            chunk(Some("c1"), "F"),
            chunk(None, "G"),
            Event::run_finished_success("t", "r"),
        ]
    );
    assert_eq!(*outcomes.lock().unwrap(), vec![Ok(()); continuing.len()]);

    #[cfg(feature = "client")]
    {
        let run = [sent.as_slice(), rest.as_slice()].concat();
        ag_ui::client::verify_all(&run).expect("one well-formed run");
        let expanded = ag_ui::client::normalize_all(run).expect("normalizes");
        let args: Vec<(&str, &str)> = expanded
            .iter()
            .filter_map(|event| match event {
                Event::ToolCallArgs(args) => {
                    Some((args.tool_call_id.as_str(), args.delta.as_str()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(args, [("c1", "A"), ("c1", "F"), ("c1", "G")]);
    }
}

/// A transformer of your own is shown what the run already sent: once, after
/// the history, before the first event of the driver that continues the run.
#[tokio::test]
async fn a_custom_transformer_is_shown_what_was_sent_before_a_continuation_s_first_event() {
    use ag_ui::server::StreamTransformer;

    struct Records(Arc<Mutex<Vec<String>>>);

    impl StreamTransformer for Records {
        fn seed(&mut self, history: &[Message]) {
            let ids = history.iter().map(|message| message.id().to_string());
            self.0
                .lock()
                .unwrap()
                .push(format!("seed {:?}", ids.collect::<Vec<_>>()));
        }

        fn replay(&mut self, sent: &[Event]) {
            let types: Vec<_> = sent.iter().map(Event::event_type).collect();
            self.0.lock().unwrap().push(format!("replay {types:?}"));
        }

        fn transform(&mut self, event: Event) -> Vec<Event> {
            let seen = format!("transform {}", event.event_type());
            self.0.lock().unwrap().push(seen);
            vec![event]
        }
    }

    let mut request = input();
    request.messages = vec![Message::user("u1", "hi")];
    let sent = stopped_mid_call();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let runner = Runner::new(FinishesTheCall).transformer(Records(Arc::clone(&seen)));
    continued(runner, request, &sent).await;
    assert_eq!(
        *seen.lock().unwrap(),
        [
            r#"seed ["u1"]"#,
            "replay [RunStarted, ToolCallStart, ToolCallArgs]",
            "transform TOOL_CALL_ARGS",
            "transform TOOL_CALL_END",
            "transform TOOL_CALL_RESULT",
            "transform RUN_FINISHED",
        ]
    );
}

#[tokio::test]
async fn a_continuation_promotes_the_result_of_a_call_the_first_driver_made() {
    let sent = [
        Event::run_started("t", "r"),
        Event::tool_call_start("c1", "load_document"),
        Event::tool_call_end("c1"),
    ];
    let result = Event::tool_call_result("m1", "c1", r#"{"title":"Notes"}"#);
    let agent = Reports {
        events: vec![result.clone()],
        outcomes: Outcomes::default(),
    };
    let runner = Runner::new(agent).transformer(ToolResultToState::snapshot("load_document"));
    assert_eq!(
        continued(runner, input(), &sent).await,
        [
            result,
            Event::state_snapshot(json!({ "title": "Notes" })),
            Event::run_finished_success("t", "r"),
        ]
    );
}

fn cancelled_run_finished() -> Event {
    RunFinishedEvent::new("t", "r")
        .with_outcome(RunOutcome::Cancelled)
        .into()
}

/// Cancelled before it could do anything. It has no handle for what the
/// first driver opened, and an emit after cancellation fails, a terminator
/// included.
struct CancelledAtOnce;

impl Agent for CancelledAtOnce {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.cancellation_token().cancel();
        let by_hand = ctx.emit(Event::text_message_end("r-msg-1"));
        assert!(by_hand.is_err_and(|error| error.is_cancelled()));
        ctx.check_cancelled()?;
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn a_cancelled_continuation_closes_what_the_first_driver_left_open() {
    let sent = stopped_mid_run(Runner::new(Stalls), input());
    let rest = continued(Runner::new(CancelledAtOnce), input(), &sent).await;
    assert_eq!(
        rest,
        [Event::text_message_end("r-msg-1"), cancelled_run_finished()],
        "a cancelled run closes what it had open and ends as cancelled"
    );

    // One of everything, nested: the driver closes the innermost first, each
    // under the subagent that opened it.
    let helper = |event: Event| event.with_subagent_run_id("helper-1");
    let sent = [
        Event::run_started("t", "r"),
        Event::step_started("work"),
        // Closed before the first driver stopped: not the driver's to close.
        Event::text_message_start("m0", TextMessageRole::Assistant),
        Event::text_message_end("m0"),
        Event::reasoning_start("think-1"),
        Event::reasoning_message_start("think-1"),
        Event::reasoning_message_content("think-1", "Hm."),
        Event::subagent_started("helper-1", "helper"),
        helper(Event::text_message_start("m1", TextMessageRole::Assistant)),
        helper(Event::tool_call_start("c1", "search")),
        helper(Event::step_started("work")),
    ];
    let rest = continued(Runner::new(CancelledAtOnce), input(), &sent).await;
    let closed: Vec<(EventType, Option<&str>)> = rest
        .iter()
        .map(|event| {
            let owner = event.subagent_run_id().map(|id| id.as_str());
            (event.event_type(), owner)
        })
        .collect();
    assert_eq!(
        closed,
        [
            (EventType::StepFinished, Some("helper-1")),
            (EventType::ToolCallEnd, Some("helper-1")),
            (EventType::TextMessageEnd, Some("helper-1")),
            (EventType::SubagentError, Some("helper-1")),
            (EventType::ReasoningMessageEnd, None),
            (EventType::ReasoningEnd, None),
            (EventType::StepFinished, None),
            (EventType::RunFinished, None),
        ],
        "{rest:?}"
    );
    assert_eq!(rest.last(), Some(&cancelled_run_finished()));

    let run = [sent.as_slice(), rest.as_slice()].concat();
    #[cfg(feature = "client")]
    ag_ui::client::verify_all(&run).expect("one well-formed run");
    #[cfg(feature = "verify")]
    ag_ui::server::EventVerifier::new()
        .replay(&run)
        .expect("one well-formed run");
    let _ = run;
}

#[tokio::test]
async fn what_a_continuation_closed_itself_is_not_closed_again() {
    struct ClosesThenCancelled;
    impl Agent for ClosesThenCancelled {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::text_message_end("r-msg-1"))?;
            ctx.cancellation_token().cancel();
            ctx.check_cancelled()?;
            Ok(RunOutcome::Success)
        }
    }
    let sent = stopped_mid_run(Runner::new(Stalls), input());
    let rest = continued(Runner::new(ClosesThenCancelled), input(), &sent).await;
    assert_eq!(
        rest,
        [Event::text_message_end("r-msg-1"), cancelled_run_finished()]
    );
}

/// The largest number an id counter can hold.
const LAST: u64 = u64::MAX;

#[tokio::test]
async fn an_id_that_was_sent_cannot_exhaust_the_ids_a_continuation_hands_out() {
    // A request for run `r` names a message by an id of the shape a context
    // hands out, with the largest number there is, and the run echoed it.
    // A call and a subagent of the same shape were sent as well. The first
    // of each kind is in use too: by a message, by a call that message
    // carries, and by the subagent it is attributed to.
    let mut request = input();
    request.messages = vec![
        Message::user(format!("r-msg-{LAST}"), "hi"),
        Message::Assistant(AssistantMessage {
            id: "r-msg-1".into(),
            tool_calls: Some(vec![ToolCall::new("r-call-1", "search", "{}")]),
            subagent_run_id: Some("r-sub-1".into()),
            ..Default::default()
        }),
    ];
    let mut started = RunStartedEvent::new("t", "r");
    started.input = Some(Box::new(request.clone()));
    let sent = [
        Event::from(started),
        Event::tool_call_start(format!("r-call-{LAST}"), "search"),
        Event::tool_call_end(format!("r-call-{LAST}")),
        Event::subagent_started(format!("r-sub-{LAST}"), "helper"),
        Event::subagent_finished_success(format!("r-sub-{LAST}")),
        // Attributed to a subagent that no event announced.
        Event::custom("note", json!(1)).with_subagent_run_id("r-sub-2"),
    ];

    struct MintsOfEachKind;
    impl Agent for MintsOfEachKind {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("one")?;
            ctx.say("two")?;
            ctx.tool_call("search")?.end()?;
            ctx.tool_call("search")?.end()?;
            ctx.subagent("helper")?.finish()?;
            ctx.subagent("helper")?.finish()?;
            Ok(RunOutcome::Success)
        }
    }

    // `continued` asserts the driver did not panic.
    let rest = continued(Runner::new(MintsOfEachKind), request, &sent).await;
    assert_eq!(rest.last(), Some(&Event::run_finished_success("t", "r")));
    let minted: Vec<String> = rest
        .iter()
        .filter_map(|event| match event {
            Event::TextMessageStart(e) => Some(e.message_id.to_string()),
            Event::ToolCallStart(e) => Some(e.tool_call_id.to_string()),
            Event::SubagentStarted(e) => Some(e.subagent_run_id.to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(minted.len(), 6, "{rest:?}");
    let in_use = [
        format!("r-msg-{LAST}"),
        "r-msg-1".to_owned(),
        format!("r-call-{LAST}"),
        "r-call-1".to_owned(),
        format!("r-sub-{LAST}"),
        "r-sub-1".to_owned(),
        "r-sub-2".to_owned(),
    ];
    for (index, id) in minted.iter().enumerate() {
        assert!(!in_use.contains(id), "{id} was already in use");
        assert!(!minted[..index].contains(id), "{id} was handed out twice");
    }
}

/// `continue_run`'s error, without the halves an `Ok` would carry.
fn refusal(input: RunAgentInput, sent: &[Event]) -> Error {
    let refused: Result<(_, EventReceiver)> = Runner::new(Finishes).continue_run(input, sent);
    match refused {
        Ok(_) => panic!("there was no run to continue in {sent:?}"),
        Err(error) => error,
    }
}

#[test]
fn there_has_to_be_a_run_to_continue() {
    let started = Event::run_started("t", "r");

    let nothing = refusal(input(), &[]);
    assert_eq!(
        nothing.to_string(),
        "RUN_STARTED breaks rule `out-of-order` (the event arrived before the event it depends \
         on): there is no run to continue: no RUN_STARTED was sent"
    );

    for terminal in [
        Event::run_finished_success("t", "r"),
        Event::run_error("it failed"),
    ] {
        let ended = refusal(input(), &[started.clone(), terminal.clone()]);
        let Error::Verification(error) = &ended else {
            panic!("{ended}");
        };
        assert_eq!(error.event, terminal.event_type());
        assert_eq!(error.rule, ag_ui::server::Rule::RunEnded);
        assert!(error.detail.ends_with("the run already ended"), "{ended}");
    }

    let other = refusal(
        RunAgentInput::new("t", "another"),
        std::slice::from_ref(&started),
    );
    assert_eq!(
        other.to_string(),
        "protocol violation: the run that was started is \"r\" on thread \"t\", and the input \
         to continue it names run \"another\" on thread \"t\""
    );

    // With the verifier, a stored stream that is not a run's is refused at
    // the event that shows it.
    #[cfg(feature = "verify")]
    {
        let orphan = Event::text_message_content("m1", "no start");
        let Error::Verification(error) = refusal(input(), &[started, orphan]) else {
            panic!("expected the content event's own rejection");
        };
        assert_eq!(error.event, EventType::TextMessageContent);
        assert_eq!(error.rule, ag_ui::server::Rule::NotOpen);
    }
}
