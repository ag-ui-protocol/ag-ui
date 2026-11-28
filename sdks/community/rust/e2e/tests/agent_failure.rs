//! An agent that returns `Err` must still produce a well-formed stream.
//!
//! By the time an agent can fail, the `200` and the content type are long sent,
//! so the failure has nowhere to go but *into* the stream. The three things
//! that must not happen — a dropped connection, a panic, a hang — all look the
//! same to a client, and all three are ruled out here: the run ends in
//! `RUN_ERROR`, the client reports it as an error, and everything the agent
//! managed to say first is still in the transcript.

mod common;

use std::time::Duration;

use ag_ui::client::{Error as ClientError, RemoteAgent, RunEnd, RunParams, Thread, Update};
use ag_ui::server::{Agent, Error, Result, RunContext};
use ag_ui::{Event, EventType, Message, RunOutcome, TextMessageRole};
use common::{serve, transport};
use futures_util::StreamExt as _;
use serde_json::json;
use tokio::time::timeout;

/// Fails halfway through a sentence. The handle's `Drop` still closes the
/// message.
struct Broken;

impl Agent for Broken {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let mut message = ctx.assistant_message()?;
        message.delta("Looking that up")?;
        Err(Error::agent("the weather service is down"))
    }
}

/// Fails with a message it opened by hand and never closed — the case
/// `RUN_ERROR` is exempt from the ordering rules for.
struct Abrupt;

impl Agent for Abrupt {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.emit(Event::text_message_start(
            "half",
            TextMessageRole::Assistant,
        ))?;
        ctx.emit(Event::text_message_content("half", "I was saying"))?;
        Err(Error::agent("the connection to the model dropped"))
    }
}

/// Does not fail — panics. The one way out of an agent that the run driver
/// deliberately does not catch.
struct Exploder;

impl Agent for Exploder {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.say("Looking that up")?;
        panic!("the tool returned something impossible");
    }
}

/// Never gets to run: the state it is typed against will not decode.
struct Picky;

impl Agent for Picky {
    type State = u32;

    async fn run(&self, ctx: &mut RunContext<u32>) -> Result<RunOutcome> {
        ctx.say("this should never be reached")?;
        Ok(RunOutcome::Success)
    }
}

/// Every test here has a deadline: a hang is one of the failures being ruled
/// out, and it would otherwise present as a test that never returns.
const DEADLINE: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_agent_ends_its_stream_with_run_error() {
    let url = serve(Broken).await;
    let agent = RemoteAgent::new(transport(&url));

    let events: Vec<Event> = timeout(DEADLINE, async {
        agent
            .run_events(RunParams::new("broken", "broken-run-1"))
            .map(|event| event.expect("a failing agent is not a broken stream"))
            .collect()
            .await
    })
    .await
    .expect("a failing agent must not hang");

    let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            // Emitted by the handle's Drop, on the way out of the `?`.
            EventType::TextMessageEnd,
            EventType::RunError,
        ]
    );

    let Some(Event::RunError(error)) = events.last() else {
        panic!("the stream must end with RUN_ERROR: {types:?}");
    };
    assert_eq!(error.code.as_deref(), Some("AGENT_ERROR"));
    assert!(
        error.message.contains("the weather service is down"),
        "{error:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_client_surfaces_the_failure_as_an_error_and_a_failed_ending() {
    let url = serve(Broken).await;
    let mut thread = Thread::<_>::new(transport(&url), "broken");
    thread.set_next_run_id("broken-run-1");

    let updates = timeout(DEADLINE, async {
        let mut updates = Vec::new();
        let mut run = thread.send("what is the weather?").expect("run preflight");
        while let Some(update) = run.next().await {
            updates.push(update);
        }
        updates
    })
    .await
    .expect("a failing agent must not hang");

    let mut tail = updates.iter().rev();
    match tail.next() {
        Some(Update::Done(RunEnd::Failed { message, code })) => {
            assert!(message.contains("the weather service is down"), "{message}");
            assert_eq!(code.as_deref(), Some("AGENT_ERROR"));
        }
        other => panic!("the run must end as Failed, not {other:?}"),
    }
    match tail.next() {
        Some(Update::Error(ClientError::Run { message, code })) => {
            assert!(message.contains("the weather service is down"), "{message}");
            assert_eq!(code.as_deref(), Some("AGENT_ERROR"));
        }
        other => panic!("the failure must arrive as an error update too, not {other:?}"),
    }

    // A `RUN_ERROR` is a report, not a truncation: nothing here should look
    // like a broken transport or a stream that stopped early.
    for update in &updates {
        if let Update::Error(error) = update {
            assert!(
                matches!(error, ClientError::Run { .. }),
                "the only error should be the agent's own: {error}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn what_the_agent_managed_to_say_before_failing_is_kept() {
    let url = serve(Broken).await;
    let mut thread = Thread::<_>::new(transport(&url), "broken");
    thread.set_next_run_id("broken-run-1");

    {
        let mut run = thread.send("what is the weather?").expect("run preflight");
        while run.next().await.is_some() {}
    }

    assert_eq!(
        thread.messages().last(),
        Some(&Message::assistant("broken-run-1-msg-1", "Looking that up"))
    );
}

/// `RUN_ERROR` is exempt from "everything opened must be closed", on both
/// sides — a run that blew up mid-message could not have closed it.
#[tokio::test(flavor = "multi_thread")]
async fn a_failure_with_a_message_still_open_is_still_a_clean_stream() {
    let url = serve(Abrupt).await;
    let mut thread = Thread::<_>::new(transport(&url), "abrupt");

    let updates = timeout(DEADLINE, async {
        let mut updates = Vec::new();
        let mut run = thread.send("go on").expect("run preflight");
        while let Some(update) = run.next().await {
            updates.push(update);
        }
        updates
    })
    .await
    .expect("an unclosed message must not hang the client");

    let errors: Vec<&ClientError> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error),
            _ => None,
        })
        .collect();
    assert_eq!(errors.len(), 1, "only the agent's failure: {errors:?}");
    assert!(matches!(errors[0], ClientError::Run { .. }), "{errors:?}");

    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Failed { .. }))
    ));
    assert_eq!(
        thread.messages().last(),
        Some(&Message::assistant("half", "I was saying"))
    );
}

/// A panic is not an `Err`, and the run driver deliberately does not catch it:
/// it unwinds through whoever polls the stream, which here is the connection
/// task. So there is no `RUN_ERROR` to be had — the response body simply stops
/// mid-message, and this file's other guarantees do not apply.
///
/// What still has to hold is the one a UI is built on: the run *ends*, and it
/// ends saying it failed. A frontend that re-enables its input on
/// [`Update::Done`] would otherwise be left with a spinner and no way out, and
/// nothing between here and the agent would ever say why.
#[tokio::test(flavor = "multi_thread")]
async fn a_panicking_agent_ends_the_clients_run_rather_than_hanging_it() {
    let url = serve(Exploder).await;
    let mut thread = Thread::<_>::new(transport(&url), "boom");

    let updates = timeout(DEADLINE, async {
        let mut updates = Vec::new();
        let mut run = thread.send("what is the weather?").expect("run preflight");
        while let Some(update) = run.next().await {
            updates.push(update);
        }
        updates
    })
    .await
    .expect("a panicking agent must not hang the client");

    match updates.last() {
        Some(Update::Done(RunEnd::Failed { .. })) => {}
        other => panic!("a run whose agent panicked must not end as {other:?}"),
    }
    // The failure is described before it is declared, however the connection
    // died — a truncated body and a broken transport are both reported, and
    // neither is allowed to arrive as a bare `Done`.
    assert!(
        updates
            .iter()
            .any(|update| matches!(update, Update::Error(_))),
        "the run failed without saying anything about it: {updates:?}"
    );
}

/// The request is well-formed AG-UI but its state does not fit the agent's
/// type. That is decided before the agent body runs, and by then the `200` has
/// gone out — so it is a `RUN_ERROR` too, not a `400`.
#[tokio::test(flavor = "multi_thread")]
async fn a_state_the_agent_cannot_decode_fails_the_run_rather_than_the_request() {
    let url = serve(Picky).await;
    let client = RemoteAgent::new(transport(&url));

    let events: Vec<Event> = client
        .run_events(RunParams::new("picky", "picky-run-1").state(json!({"not": "a number"})))
        .map(|event| event.expect("a rejected state is not a broken stream"))
        .collect()
        .await;

    let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
    assert_eq!(types, [EventType::RunStarted, EventType::RunError]);

    let Some(Event::RunError(error)) = events.last() else {
        panic!("the stream must end with RUN_ERROR: {types:?}");
    };
    assert_eq!(error.code.as_deref(), Some("SERIALIZATION"));
}
