//! Subagents, closed over real HTTP.
//!
//! A subagent is a *scope* on the server — everything emitted inside it comes
//! out tagged with the invocation's `subagentRunId` — and a *group* on the
//! client, which sorts the events it receives back into the subagent that
//! produced them. Nothing in between is mocked: each test mounts an agent on a
//! loopback port and reads it back through the client's own HTTP transport,
//! so every `subagentRunId` asserted on here has been through SSE framing and
//! the owner-aware verifier on both sides.
//!
//! Five shapes, one per test group: sequential and nested through the handle;
//! two subagents streaming at once, tagged by hand; a subagent that pauses the
//! run and is continued under the same id; and the two visibility modes that
//! flatten or drop the subagent surface for a client that predates it.

mod common;

use ag_ui::axum::AgentEndpoint;
use ag_ui::client::transport::HttpTransport;
use ag_ui::client::{
    HttpAgent, RunEnd, RunParams, SubagentChangeKind, SubagentStatus, Thread, Update,
};
use ag_ui::server::{Agent, Result, RunContext, SubagentVisibility};
use ag_ui::{
    Event, EventType, Interrupt, Message, ResumeStatus, RunOutcome, SubagentRunId,
    SubagentStartedEvent, TextMessageRole,
};
use common::{serve, serve_endpoint, transport};
use futures_util::StreamExt as _;
use serde_json::json;

// ---- the agents -------------------------------------------------------------

/// Delegates to a planner, which delegates an estimate to a third agent that
/// runs a tool — sequential and nested, all through the handle.
struct Supervisor;

impl Agent for Supervisor {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.say("Planning.")?;
        {
            let mut planner = ctx.subagent("planner")?;
            planner.say("Two steps.")?;
            {
                // Opened through the planner's handle, so its parent link is
                // filled in without either agent naming it.
                let mut estimator = planner.subagent("estimator")?;
                let mut call = estimator.tool_call("estimate")?;
                call.args_json(&json!({"steps": 2}))?;
                call.result_json(&json!({"minutes": 30}))?;
                estimator.finish_with(json!({"minutes": 30}))?;
            }
            planner.say("Thirty minutes.")?;
            planner.finish()?;
        }
        ctx.say("Done.")?;
        Ok(RunOutcome::Success)
    }
}

/// Two researchers streaming at once. Handles cannot overlap — the borrow
/// checker sees to that — so this is the other supported mode: the agent tags
/// each event itself and interleaves them however it likes.
struct Interleaved;

impl Agent for Interleaved {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let gdp = ctx.new_subagent_run_id();
        let pop = ctx.new_subagent_run_id();
        let tagged = |event: Event, id: &SubagentRunId| event.with_subagent_run_id(id.clone());

        ctx.emit(Event::subagent_started(gdp.clone(), "researcher"))?;
        ctx.emit(Event::subagent_started(pop.clone(), "researcher"))?;
        ctx.emit(tagged(
            Event::text_message_start("m-gdp", TextMessageRole::Assistant),
            &gdp,
        ))?;
        ctx.emit(tagged(
            Event::text_message_start("m-pop", TextMessageRole::Assistant),
            &pop,
        ))?;
        ctx.emit(tagged(Event::text_message_content("m-gdp", "GDP "), &gdp))?;
        ctx.emit(tagged(
            Event::text_message_content("m-pop", "Population "),
            &pop,
        ))?;
        ctx.emit(tagged(Event::text_message_content("m-gdp", "is up."), &gdp))?;
        ctx.emit(tagged(
            Event::text_message_content("m-pop", "is flat."),
            &pop,
        ))?;
        ctx.emit(tagged(Event::text_message_end("m-pop"), &pop))?;
        ctx.emit(Event::subagent_finished_success(pop))?;
        ctx.emit(tagged(Event::text_message_end("m-gdp"), &gdp))?;
        ctx.emit(Event::subagent_finished_success(gdp))?;
        Ok(RunOutcome::Success)
    }
}

const APPROVAL: &str = "approve-purchase";
/// The buyer's invocation id: fixed, because the run that resumes it has to
/// announce the *same* id for the client to read it as a continuation.
const BUYER: &str = "buyer-7";

/// A subagent that needs a human before it can finish. The first run pauses
/// inside the subagent; the resuming run picks the same invocation back up.
struct Purchasing;

impl Agent for Purchasing {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let answer = ctx.resume_for(APPROVAL).map(|entry| entry.status);
        let mut buyer = ctx.subagent_with(SubagentStartedEvent::new(BUYER, "buyer"))?;

        match answer {
            None => {
                buyer.say("This costs 40. May I?")?;
                buyer.suspend([APPROVAL.to_owned()])?;
                Ok(RunOutcome::interrupt(vec![
                    Interrupt::new(APPROVAL, "tool_approval").with_subagent_run_id(BUYER),
                ]))
            }
            Some(ResumeStatus::Resolved) => {
                buyer.say("Bought.")?;
                buyer.finish_with(json!({"bought": true}))?;
                Ok(RunOutcome::Success)
            }
            Some(ResumeStatus::Cancelled) => {
                buyer.fail_with_code("the purchase was declined", "declined")?;
                Ok(RunOutcome::Success)
            }
        }
    }
}

// ---- helpers ----------------------------------------------------------------

/// Drains a run, returning every update it produced.
async fn drain<T: ag_ui::client::Transport>(
    mut run: ag_ui::client::RunStream<'_, T>,
) -> Vec<Update> {
    let mut updates = Vec::new();
    while let Some(update) = run.next().await {
        updates.push(update);
    }
    updates
}

/// Everything the run reported as an error.
fn errors(updates: &[Update]) -> Vec<String> {
    updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect()
}

/// The subagent lifecycle the client reported, as `(name, change)` pairs.
fn lifecycle(updates: &[Update]) -> Vec<(String, SubagentChangeKind)> {
    updates
        .iter()
        .filter_map(|update| match update {
            Update::Subagent(subagent) => {
                Some((subagent.subagent.name.clone(), subagent.change.clone()))
            }
            _ => None,
        })
        .collect()
}

/// The assistant messages, as `(text, owner)` pairs.
fn said<T>(thread: &Thread<T>) -> Vec<(String, Option<&str>)> {
    thread
        .messages()
        .iter()
        .filter_map(|message| match message {
            Message::Assistant(assistant) => Some((
                assistant.content.clone().unwrap_or_default(),
                message.subagent_run_id().map(SubagentRunId::as_str),
            )),
            _ => None,
        })
        .collect()
}

/// The raw events one run puts on the wire.
async fn wire(url: &str, thread: &str) -> Vec<Event> {
    let agent = HttpAgent::new(url).expect("a valid endpoint URL");
    agent
        .run_events(RunParams::new(thread, "r1").user("m1", "go"))
        .map(|event| event.expect("the stream should not break"))
        .collect()
        .await
}

// ---- sequential and nested --------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn nested_subagents_arrive_as_a_lifecycle_and_attributed_messages() {
    let url = serve(Supervisor).await;
    let mut thread = Thread::<HttpTransport>::new(transport(&url), "nested");

    let updates = drain(thread.send("plan it").expect("run preflight")).await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Success { .. }))
    ));

    // The lifecycle, in the order the scopes opened and closed.
    assert_eq!(
        lifecycle(&updates),
        [
            ("planner".to_owned(), SubagentChangeKind::Started),
            ("estimator".to_owned(), SubagentChangeKind::Started),
            ("estimator".to_owned(), SubagentChangeKind::Finished),
            ("planner".to_owned(), SubagentChangeKind::Finished),
        ]
    );

    // The registry: two invocations, the inner one linked to the outer.
    let subagents = thread.subagents();
    assert_eq!(subagents.len(), 2, "{subagents:?}");
    let (planner, estimator) = (&subagents[0], &subagents[1]);
    assert_eq!(planner.name, "planner");
    assert_eq!(planner.parent_subagent_run_id, None);
    assert_eq!(
        estimator.parent_subagent_run_id.as_ref(),
        Some(&planner.run_id),
        "a subagent opened through a handle names that handle as its parent"
    );
    assert_eq!(
        estimator.status,
        SubagentStatus::Finished {
            result: Some(json!({"minutes": 30}))
        }
    );
    assert_eq!(planner.status, SubagentStatus::Finished { result: None });

    // Every message is owned by whoever was speaking when it opened.
    let planner_id = planner.run_id.as_str();
    let estimator_id = estimator.run_id.as_str();
    assert_eq!(
        said(&thread),
        [
            ("Planning.".to_owned(), None),
            ("Two steps.".to_owned(), Some(planner_id)),
            // The estimator's tool call rides an assistant message of its own.
            (String::new(), Some(estimator_id)),
            ("Thirty minutes.".to_owned(), Some(planner_id)),
            ("Done.".to_owned(), None),
        ]
    );
    // The tool result is attributed too, so a client can file it under the
    // subagent that ran the tool.
    let result = thread
        .messages()
        .iter()
        .find_map(|message| match message {
            Message::Tool(tool) => Some((tool.content.as_str(), message.subagent_run_id())),
            _ => None,
        })
        .expect("the estimator's tool result");
    assert_eq!(result.0, r#"{"minutes":30}"#);
    assert_eq!(result.1.map(SubagentRunId::as_str), Some(estimator_id));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wire_carries_the_attribution_and_the_parent_link() {
    let url = serve(Supervisor).await;
    let events = wire(&url, "wire").await;

    let starts: Vec<&ag_ui::SubagentStartedEvent> = events
        .iter()
        .filter_map(|event| match event {
            Event::SubagentStarted(started) => Some(started),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 2, "{events:?}");
    assert_eq!(starts[0].name, "planner");
    assert_eq!(starts[1].name, "estimator");
    assert_eq!(
        starts[1].parent_subagent_run_id.as_ref(),
        Some(&starts[0].subagent_run_id)
    );

    // Everything between the estimator's start and its finish is tagged with
    // it; the lifecycle events themselves and the parent's own text are not.
    let estimator = &starts[1].subagent_run_id;
    let opened = events
        .iter()
        .position(
            |event| matches!(event, Event::SubagentStarted(e) if &e.subagent_run_id == estimator),
        )
        .expect("the estimator opened");
    let closed = events
        .iter()
        .position(
            |event| matches!(event, Event::SubagentFinished(e) if &e.subagent_run_id == estimator),
        )
        .expect("the estimator closed");
    assert!(
        events[opened + 1..closed]
            .iter()
            .all(|event| event.subagent_run_id() == Some(estimator)),
        "{events:?}"
    );
    // A lifecycle event is not attributed; its `subagentRunId` is the
    // subagent it announces.
    assert!(!events[opened].event_type().is_attributable());
    assert_eq!(events[opened].subagent_run_id(), Some(estimator));
    assert_eq!(events[closed].subagent_run_id(), Some(estimator));
    assert_eq!(events[1].event_type(), EventType::TextMessageStart);
    assert_eq!(
        events[1].subagent_run_id(),
        None,
        "the parent's own message"
    );
}

// ---- concurrent, by hand ----------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn two_subagents_may_stream_at_once_under_their_own_tags() {
    let url = serve(Interleaved).await;
    let mut thread = Thread::<HttpTransport>::new(transport(&url), "interleaved");

    let updates = drain(thread.send("research both").expect("run preflight")).await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));

    let subagents = thread.subagents();
    assert_eq!(subagents.len(), 2, "{subagents:?}");
    assert!(
        subagents
            .iter()
            .all(|subagent| subagent.status == SubagentStatus::Finished { result: None }),
        "{subagents:?}"
    );

    // Two messages, each whole, each owned by the researcher that streamed it
    // — the interleaving on the wire did not cross them.
    let gdp = subagents[0].run_id.as_str();
    let pop = subagents[1].run_id.as_str();
    assert_eq!(
        said(&thread),
        [
            ("GDP is up.".to_owned(), Some(gdp)),
            ("Population is flat.".to_owned(), Some(pop)),
        ]
    );
}

// ---- suspended, then continued ---------------------------------------------

/// Runs the first turn: the buyer pauses, and the thread holds its interrupt.
async fn pause() -> (Thread<HttpTransport>, Interrupt) {
    let url = serve(Purchasing).await;
    let mut thread = Thread::<HttpTransport>::new(transport(&url), "buy");

    let updates = drain(thread.send("buy the thing").expect("run preflight")).await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert_eq!(
        lifecycle(&updates),
        [
            ("buyer".to_owned(), SubagentChangeKind::Started),
            ("buyer".to_owned(), SubagentChangeKind::Suspended),
        ]
    );

    let interrupt = updates
        .iter()
        .find_map(|update| match update {
            Update::Interrupt(interrupt) => Some(interrupt.clone()),
            _ => None,
        })
        .expect("the run paused");
    (thread, interrupt)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_subagent_that_pauses_the_run_is_suspended_and_owns_the_interrupt() {
    let (thread, interrupt) = pause().await;

    // The interrupt names the subagent, so a client can render the question
    // inside that subagent's group rather than at the top level.
    assert_eq!(interrupt.id, APPROVAL);
    assert_eq!(
        interrupt
            .subagent_run_id
            .as_ref()
            .map(SubagentRunId::as_str),
        Some(BUYER)
    );

    let buyer = thread
        .subagent(&SubagentRunId::from(BUYER))
        .expect("the buyer is registered");
    assert_eq!(
        buyer.status,
        SubagentStatus::Suspended {
            result: None,
            interrupt_ids: vec![APPROVAL.to_owned()],
        }
    );
    assert_eq!(
        said(&thread),
        [("This costs 40. May I?".to_owned(), Some(BUYER))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_resuming_run_continues_the_same_invocation() {
    let (mut thread, interrupt) = pause().await;

    let updates = drain(
        thread
            .resume(&interrupt, json!({"ok": true}))
            .expect("run preflight"),
    )
    .await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Success { .. }))
    ));

    // The same id announced again is a continuation, not a second subagent.
    assert_eq!(
        lifecycle(&updates),
        [
            ("buyer".to_owned(), SubagentChangeKind::Resumed),
            ("buyer".to_owned(), SubagentChangeKind::Finished),
        ]
    );
    assert_eq!(thread.subagents().len(), 1, "{:?}", thread.subagents());
    assert_eq!(
        thread.subagents()[0].status,
        SubagentStatus::Finished {
            result: Some(json!({"bought": true}))
        }
    );
    // Both runs' messages belong to the one invocation.
    assert_eq!(
        said(&thread),
        [
            ("This costs 40. May I?".to_owned(), Some(BUYER)),
            ("Bought.".to_owned(), Some(BUYER)),
        ]
    );
    assert!(thread.interrupts().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_answer_fails_the_continued_invocation() {
    let (mut thread, interrupt) = pause().await;

    let updates = drain(thread.decline(&interrupt).expect("run preflight")).await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert_eq!(
        lifecycle(&updates),
        [
            ("buyer".to_owned(), SubagentChangeKind::Resumed),
            ("buyer".to_owned(), SubagentChangeKind::Failed),
        ]
    );
    assert_eq!(
        thread.subagents()[0].status,
        SubagentStatus::Failed {
            message: "the purchase was declined".to_owned(),
            code: Some("declined".to_owned()),
        }
    );
    // The run itself succeeded: a failed subagent is the parent's to handle.
    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Success { .. }))
    ));
}

// ---- visibility -------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn inline_visibility_hides_the_subagent_surface_and_keeps_the_work() {
    let endpoint = AgentEndpoint::new(Supervisor).transformer(SubagentVisibility::inline);
    let url = serve_endpoint(endpoint).await;

    // On the wire: no lifecycle events, no attribution anywhere.
    let events = wire(&url, "inline").await;
    assert!(
        events.iter().all(|event| !matches!(
            event.event_type(),
            EventType::SubagentStarted | EventType::SubagentFinished | EventType::SubagentError
        )),
        "{events:?}"
    );
    assert!(
        events.iter().all(|event| event.subagent_run_id().is_none()),
        "{events:?}"
    );
    // The JSON agrees: the key never appears, so a pre-subagent client that
    // rejects unknown fields is safe too.
    for event in &events {
        let json = serde_json::to_string(event).expect("serializes");
        assert!(!json.contains("subagentRunId"), "{json}");
    }

    // Through the thread: everything the subagents did still assembles, as
    // the parent's own work.
    let mut thread = Thread::<HttpTransport>::new(transport(&url), "inline-thread");
    let updates = drain(thread.send("plan it").expect("run preflight")).await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert!(lifecycle(&updates).is_empty());
    assert!(thread.subagents().is_empty());
    assert_eq!(
        said(&thread),
        [
            ("Planning.".to_owned(), None),
            ("Two steps.".to_owned(), None),
            (String::new(), None),
            ("Thirty minutes.".to_owned(), None),
            ("Done.".to_owned(), None),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn hidden_visibility_delivers_only_the_parents_own_events() {
    let endpoint = AgentEndpoint::new(Supervisor).transformer(SubagentVisibility::hidden);
    let url = serve_endpoint(endpoint).await;

    let events = wire(&url, "hidden").await;
    let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ],
        "{types:?}"
    );

    let mut thread = Thread::<HttpTransport>::new(transport(&url), "hidden-thread");
    let updates = drain(thread.send("plan it").expect("run preflight")).await;
    assert!(errors(&updates).is_empty(), "{:?}", errors(&updates));
    assert!(thread.subagents().is_empty());
    assert_eq!(
        said(&thread),
        [("Planning.".to_owned(), None), ("Done.".to_owned(), None)]
    );
    assert!(
        thread
            .messages()
            .iter()
            .all(|message| !matches!(message, Message::Tool(_))),
        "the estimator's tool result is the subagent's, and it is hidden"
    );
}
