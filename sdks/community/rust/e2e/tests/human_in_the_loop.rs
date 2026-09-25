//! The interrupt round trip, closed over real HTTP.
//!
//! `RunFinished.outcome` exists for exactly this: the agent stops and says what
//! it needs, the client answers, and a *second* request carries the answer back
//! into `ctx.resume()`. Both halves of the answer are covered — resolved and
//! cancelled — and the agent fails the run outright if the payload it was
//! promised is not there, so a lost answer cannot pass as a success.
//!
//! The other half of this file is the paths a frontend actually falls down:
//! an answer the agent rejects, and a run paused on more than one decision,
//! where a client that answers them one request at a time never finishes.

mod common;

use ag_ui::client::{InterruptExt as _, RunEnd, Thread, Update};
use ag_ui::server::{Agent, Error, Result, RunContext};
use ag_ui::{Interrupt, JsonObject, Message, ResumeStatus, RunOutcome};
use common::{serve, transport};
use futures_util::StreamExt as _;
use serde_json::{Value, json};

const INTERRUPT_ID: &str = "approve-deploy";

/// Refuses to deploy until a human says so, and reports what they said.
struct Deployer;

impl Agent for Deployer {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let Some(answer) = ctx.resume_for(INTERRUPT_ID) else {
            ctx.say("Deploying to production needs a human.")?;
            return Ok(RunOutcome::interrupt(vec![request()]));
        };

        match answer.status {
            ResumeStatus::Resolved => {
                // Reading the payload is the proof that it survived the trip:
                // an answer that arrived empty fails the run instead of
                // quietly succeeding.
                let build = answer
                    .payload
                    .as_ref()
                    .and_then(|payload| payload.get("build"))
                    .and_then(Value::as_u64)
                    .ok_or_else(|| Error::agent("the approval carried no build number"))?;
                ctx.say(format!("Deployed build {build}."))?;
            }
            ResumeStatus::Cancelled => {
                ctx.say("Left production alone.")?;
            }
        }

        Ok(RunOutcome::Success)
    }
}

/// The interrupt the agent pauses on, with every optional field set so the
/// whole payload has to survive serialization.
fn request() -> Interrupt {
    let mut schema = JsonObject::new();
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("required".to_owned(), json!(["build"]));

    Interrupt {
        id: INTERRUPT_ID.to_owned(),
        reason: "tool_approval".to_owned(),
        message: Some("Deploy build 42 to production?".to_owned()),
        tool_call_id: Some("call-deploy".into()),
        response_schema: Some(schema),
        ..Default::default()
    }
}

/// Pauses on two decisions at once and reports which of them it has heard back
/// about — the shape of an agent that needs a budget *and* a date before it can
/// book anything.
struct Planner;

const BUDGET: &str = "approve-budget";
const DATE: &str = "confirm-date";

impl Agent for Planner {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        // Only this request's answers count. The agent keeps no memory of the
        // paused run, which is precisely what makes a client that answers one
        // interrupt per request go round forever.
        let pending: Vec<Interrupt> = [BUDGET, DATE]
            .into_iter()
            .filter(|id| ctx.resume_for(id).is_none())
            .map(|id| Interrupt::new(id, "tool_approval"))
            .collect();

        if pending.is_empty() {
            ctx.say("Booked.")?;
            return Ok(RunOutcome::Success);
        }

        ctx.say(format!("Still waiting on {}.", ids(&pending).join(" and ")))?;
        Ok(RunOutcome::interrupt(pending))
    }
}

/// Drains a run, returning every update it produced.
macro_rules! drain {
    ($run:expr) => {{
        let mut updates = Vec::new();
        let mut run = $run.expect("run preflight");
        while let Some(update) = run.next().await {
            updates.push(update);
        }
        updates
    }};
}

/// Everything the run reported as an error.
///
/// A pause is not a failure, so the happy paths here assert this is empty: an
/// interrupt that arrives alongside a protocol complaint is not a round trip
/// that worked, and reading only the last update would not notice.
fn errors(updates: &[Update]) -> Vec<String> {
    updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect()
}

/// The interrupts a run paused on, as the client heard them one at a time.
fn paused_on(updates: Vec<Update>) -> Vec<Interrupt> {
    updates
        .into_iter()
        .filter_map(|update| match update {
            Update::Interrupt(interrupt) => Some(interrupt),
            _ => None,
        })
        .collect()
}

/// Which decisions a set of interrupts is about — the whole of what the
/// multi-interrupt tests below need to compare.
fn ids(interrupts: &[Interrupt]) -> Vec<&str> {
    interrupts
        .iter()
        .map(|interrupt| interrupt.id.as_str())
        .collect()
}

/// The last thing the assistant said.
fn last_reply<T>(thread: &Thread<T>) -> &str {
    thread
        .messages()
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant(assistant) => assistant.content.as_deref(),
            _ => None,
        })
        .expect("the agent should have said something")
}

/// Runs the first turn and returns the thread, paused, with its interrupt.
async fn pause() -> (Thread<ag_ui::client::transport::HttpTransport>, Interrupt) {
    let url = serve(Deployer).await;
    let mut thread = Thread::<_>::new(transport(&url), "deploy");

    let updates = drain!(thread.send("ship build 42"));
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));

    let interrupts = paused_on(updates);
    assert_eq!(interrupts.len(), 1, "{interrupts:?}");
    let interrupt = interrupts.into_iter().next().expect("one interrupt");
    (thread, interrupt)
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupt_outcome_reaches_the_client_with_every_field_intact() {
    let (thread, interrupt) = pause().await;

    assert_eq!(interrupt, request(), "the interrupt must survive the wire");
    assert!(interrupt.is_tool_approval());
    assert_eq!(thread.interrupts(), [request()]);
    assert_eq!(
        last_reply(&thread),
        "Deploying to production needs a human."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_run_ends_as_interrupted_rather_than_successful() {
    let url = serve(Deployer).await;
    let mut thread = Thread::<_>::new(transport(&url), "deploy");
    let updates = drain!(thread.send("ship build 42"));

    match updates.last() {
        Some(Update::Done(RunEnd::Interrupted { interrupts })) => {
            assert_eq!(interrupts.as_slice(), [request()]);
        }
        other => panic!("a paused run must end as Interrupted, not {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resolved_answer_resumes_the_run_and_reaches_ctx_resume() {
    let (mut thread, interrupt) = pause().await;

    let updates = drain!(thread.resume(&interrupt, json!({"build": 42})));
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));

    assert_eq!(
        updates
            .last()
            .map(|update| matches!(update, Update::Done(RunEnd::Success { .. }))),
        Some(true),
        "{updates:?}"
    );
    // Only reachable by reading `answer.payload` server-side.
    assert_eq!(last_reply(&thread), "Deployed build 42.");
    assert!(
        thread.interrupts().is_empty(),
        "an answered interrupt is no longer pending"
    );

    // The resumed run has an assigned invocation ID in the same thread.
    assert!(!thread.applier().run_id().unwrap().as_str().is_empty());
    assert_eq!(thread.thread_id().as_str(), "deploy");
    assert_eq!(thread.messages().len(), 3, "{:?}", thread.messages());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_answer_resumes_the_run_down_the_other_branch() {
    let (mut thread, interrupt) = pause().await;

    let updates = drain!(thread.decline(&interrupt));
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));

    assert_eq!(
        updates
            .last()
            .map(|update| matches!(update, Update::Done(RunEnd::Success { .. }))),
        Some(true),
        "{updates:?}"
    );
    // The agent took the Cancelled branch: it neither deployed nor paused
    // again, which is what it would have done had the entry gone missing.
    assert_eq!(last_reply(&thread), "Left production alone.");
    assert!(thread.interrupts().is_empty());
}

/// Wrong interrupt IDs fail preflight without changing the pending conversation.
#[tokio::test(flavor = "multi_thread")]
async fn an_answer_to_a_different_interrupt_is_rejected_before_dispatch() {
    let (mut thread, _interrupt) = pause().await;
    let before = thread.snapshot();
    let stray = Interrupt::new("some-other-question", "tool_approval");
    assert!(
        thread
            .resume_many([stray.resolve(json!({"build": 42}))])
            .is_err()
    );
    assert_eq!(thread.snapshot(), before);
}

/// The answer that arrives in the wrong shape. A resumed run is a run like any
/// other, so the agent's rejection has to come back as a failed run rather than
/// as a pause that never resolves — and the interrupt the caller is holding has
/// to stay visible without automatically repeating a potentially executed action.
#[tokio::test(flavor = "multi_thread")]
async fn an_answer_the_agent_rejects_retains_an_unconfirmed_submission() {
    let (mut thread, interrupt) = pause().await;

    let updates = drain!(thread.resume(&interrupt, json!({"build": "forty-two"})));
    match updates.last() {
        Some(Update::Done(RunEnd::Failed { message, code })) => {
            assert!(
                message.contains("the approval carried no build number"),
                "{message}"
            );
            assert_eq!(code.as_deref(), Some("AGENT_ERROR"));
        }
        other => panic!("a rejected answer must fail the run, not {other:?}"),
    }
    assert_eq!(thread.interrupts(), std::slice::from_ref(&interrupt));
    assert!(thread.submission().is_some());
    assert!(thread.resume(&interrupt, json!({"build": 42})).is_err());
}

/// A run can pause on more than one decision, and the client hears each of them
/// separately as well as together.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_can_pause_on_several_interrupts_at_once() {
    let url = serve(Planner).await;
    let mut thread = Thread::<_>::new(transport(&url), "plan");

    let updates = drain!(thread.send("book the offsite"));
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));

    match updates.last() {
        Some(Update::Done(RunEnd::Interrupted { interrupts })) => {
            assert_eq!(ids(interrupts), [BUDGET, DATE])
        }
        other => panic!("a run paused on two decisions must say so: {other:?}"),
    }
    assert_eq!(
        paused_on(updates).len(),
        2,
        "one Update::Interrupt per pending decision"
    );
    assert_eq!(thread.interrupts().len(), 2);
    assert_eq!(
        last_reply(&thread),
        "Still waiting on approve-budget and confirm-date."
    );
}

/// A partial response is rejected locally and leaves both decisions pending.
#[tokio::test(flavor = "multi_thread")]
async fn partial_answers_do_not_discard_pending_decisions() {
    let url = serve(Planner).await;
    let mut thread = Thread::<_>::new(transport(&url), "plan");
    let pending = paused_on(drain!(thread.send("book the offsite")));
    assert_eq!(pending.len(), 2);
    assert!(
        thread
            .resume(&pending[0], json!({"amount": 5_000}))
            .is_err()
    );
    assert_eq!(ids(thread.interrupts()), [BUDGET, DATE]);

    // Both in one request is what finishes it.
    let updates = drain!(thread.resume_many([
        pending[0].resolve(json!({"amount": 5_000})),
        pending[1].resolve(json!({"day": "friday"})),
    ]));
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert!(
        matches!(updates.last(), Some(Update::Done(RunEnd::Success { .. }))),
        "{updates:?}"
    );
    assert_eq!(last_reply(&thread), "Booked.");
}
