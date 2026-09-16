//! A scripted agent, asserted event by event.
//!
//! This is the contract the rest of the SDK is written against: given this
//! agent body, these exact events come out, in this exact order, under these
//! exact ids.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, Result, RunContext, run};
use ag_ui::{
    Event, RunAgentInput, RunFinishedEvent, RunOutcome, TextMessageRole, ToolCallResultEvent,
    ToolResultRole,
};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Default, Serialize, Deserialize)]
struct Notebook {
    hits: u32,
}

struct Scripted;

impl Agent for Scripted {
    type State = Notebook;

    async fn run(&self, ctx: &mut RunContext<Notebook>) -> Result<RunOutcome> {
        let mut step = ctx.step("research")?;

        step.think("I should look this up.")?;

        let mut call = step.tool_call("search")?;
        call.args(r#"{"q":"rust"}"#)?;
        call.result(r#"{"hits":1}"#)?;

        let mut message = step.assistant_message()?;
        message.delta("Found ")?;
        message.delta("one.")?;
        message.end()?;

        step.update_state(|notebook| notebook.hits = 1)?;

        Ok(RunOutcome::Success)
    }
}

async fn collect(agent: impl Agent, input: RunAgentInput) -> Vec<Event> {
    run(agent, input)
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await
}

#[tokio::test]
async fn a_scripted_run_emits_exactly_these_events() {
    let events = collect(Scripted, RunAgentInput::new("t", "r")).await;

    let mut result = ToolCallResultEvent::new("r-msg-2", "r-call-1", r#"{"hits":1}"#);
    result.role = Some(ToolResultRole::Tool);

    assert_eq!(
        events,
        vec![
            Event::run_started("t", "r"),
            Event::step_started("research"),
            Event::reasoning_start("r-msg-1"),
            Event::reasoning_message_start("r-msg-1"),
            Event::reasoning_message_content("r-msg-1", "I should look this up."),
            Event::reasoning_message_end("r-msg-1"),
            Event::reasoning_end("r-msg-1"),
            Event::tool_call_start("r-call-1", "search"),
            Event::tool_call_args("r-call-1", r#"{"q":"rust"}"#),
            Event::tool_call_end("r-call-1"),
            result.into(),
            Event::text_message_start("r-msg-3", TextMessageRole::Assistant),
            Event::text_message_content("r-msg-3", "Found "),
            Event::text_message_content("r-msg-3", "one."),
            Event::text_message_end("r-msg-3"),
            Event::state_snapshot(json!({"hits": 1})),
            Event::step_finished("research"),
            RunFinishedEvent::new("t", "r")
                .with_outcome(RunOutcome::Success)
                .into(),
        ]
    );
}

#[tokio::test]
async fn a_second_state_change_is_a_delta() {
    struct Twice;

    impl Agent for Twice {
        type State = serde_json::Value;

        async fn run(&self, ctx: &mut RunContext<serde_json::Value>) -> Result<RunOutcome> {
            let filler = "a document long enough that patching it is worthwhile";
            ctx.set_state(&json!({"step": 1, "text": filler}))?;
            ctx.set_state(&json!({"step": 2, "text": filler}))?;
            Ok(RunOutcome::Success)
        }
    }

    let events = collect(Twice, RunAgentInput::new("t", "r")).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();

    assert_eq!(
        types,
        [
            ag_ui::EventType::RunStarted,
            ag_ui::EventType::StateSnapshot,
            ag_ui::EventType::StateDelta,
            ag_ui::EventType::RunFinished,
        ]
    );
    assert_eq!(
        events[2],
        Event::state_delta(vec![ag_ui::PatchOperation::replace("/step", 2)])
    );
}

#[tokio::test]
async fn state_arrives_typed_and_goes_out_typed() {
    struct Increment;

    impl Agent for Increment {
        type State = Notebook;

        async fn run(&self, ctx: &mut RunContext<Notebook>) -> Result<RunOutcome> {
            assert_eq!(ctx.state().hits, 7);
            ctx.update_state(|notebook| notebook.hits += 1)?;
            assert_eq!(ctx.state().hits, 8);
            Ok(RunOutcome::Success)
        }
    }

    let mut input = RunAgentInput::new("t", "r");
    input.state = json!({"hits": 7});

    let events = collect(Increment, input).await;
    assert_eq!(events[1], Event::state_snapshot(json!({"hits": 8})));
}

#[tokio::test]
async fn a_state_that_does_not_fit_the_agent_becomes_run_error() {
    let mut input = RunAgentInput::new("t", "r");
    input.state = json!({"hits": "seven"});

    let events = collect(Scripted, input).await;
    assert_eq!(events.len(), 2, "{events:#?}");
    assert_eq!(events[0].event_type(), ag_ui::EventType::RunStarted);
    let Event::RunError(error) = &events[1] else {
        panic!("expected RUN_ERROR, got {:?}", events[1]);
    };
    assert_eq!(error.code.as_deref(), Some("SERIALIZATION"));
}

#[tokio::test]
async fn the_request_can_be_echoed_on_run_started() {
    let input = RunAgentInput::new("t", "r");
    let events: Vec<Event> = ag_ui::server::Runner::new(Scripted)
        .echo_input(true)
        .run(input.clone())
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

    let Event::RunStarted(started) = &events[0] else {
        panic!("expected RUN_STARTED, got {:?}", events[0]);
    };
    assert_eq!(started.input.as_deref(), Some(&input));
}
