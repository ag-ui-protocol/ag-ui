//! One test per ordering rule, plus proof that a valid stream passes.
//!
//! The typed handles make most of these unreachable — which is the point — so
//! the violations here go through the raw [`RunContext::emit`] escape hatch.

#![cfg(feature = "server")]
#![cfg(feature = "verify")]

use ag_ui::server::{Agent, Error, EventReceiver, Result, Rule, RunContext, Runner, run};
use ag_ui::{
    AssistantMessage, Event, EventType, Interrupt, Message, ResumeEntry, RunAgentInput, RunOutcome,
    TextMessageRole, ToolCall,
};
use futures_util::StreamExt as _;

fn context() -> (RunContext<()>, EventReceiver) {
    RunContext::new(RunAgentInput::new("t", "r")).expect("an empty state always decodes")
}

/// The rule an emit was rejected by.
fn rule(error: Error) -> Rule {
    match error {
        Error::Verification(violation) => violation.rule,
        other => panic!("expected a verification error, got {other:?}"),
    }
}

#[test]
fn a_valid_stream_passes() {
    let (mut ctx, _events) = context();
    for event in [
        Event::run_started("t", "r"),
        Event::step_started("plan"),
        Event::text_message_start("m1", TextMessageRole::Assistant),
        Event::text_message_content("m1", "hello"),
        Event::text_message_end("m1"),
        Event::reasoning_start("m2"),
        Event::reasoning_message_start("m2"),
        Event::reasoning_message_content("m2", "hmm"),
        Event::reasoning_message_end("m2"),
        Event::reasoning_end("m2"),
        Event::tool_call_start("c1", "search"),
        Event::tool_call_args("c1", "{}"),
        Event::tool_call_end("c1"),
        Event::tool_call_result("m3", "c1", "ok"),
        Event::state_snapshot(serde_json::json!({"a": 1})),
        Event::custom("ping", serde_json::json!(1)),
        Event::step_finished("plan"),
        Event::run_finished_success("t", "r"),
    ] {
        ctx.emit(event.clone())
            .unwrap_or_else(|error| panic!("{event:?} should be accepted: {error}"));
    }
}

#[test]
fn parallel_tool_calls_and_overlapping_messages_are_accepted() {
    // The typestate handles cannot express this — a second overlapping handle
    // is a borrow-check error, which is the whole point of them — so parallel
    // tool calling goes through `emit`. The verifier must not be the thing that
    // stops it: upstream's client keys everything by id
    // (`client/src/verify/verify.ts`, `activeMessages` / `activeToolCalls` as
    // maps, and "should allow overlapping text messages and tool calls" in its
    // tests), so this is the stream a provider doing parallel calls sends.
    let (mut ctx, _events) = context();
    for event in [
        Event::run_started("t", "r"),
        Event::text_message_start("m1", TextMessageRole::Assistant),
        Event::text_message_content("m1", "Checking both."),
        Event::tool_call_start("c1", "get_weather"),
        Event::tool_call_start("c2", "get_time"),
        Event::tool_call_args("c1", r#"{"city":"#),
        Event::tool_call_args("c2", r#"{"zone":"#),
        Event::tool_call_args("c1", r#""Seoul"}"#),
        Event::tool_call_end("c1"),
        Event::tool_call_args("c2", r#""KST"}"#),
        Event::tool_call_end("c2"),
        Event::text_message_end("m1"),
        Event::run_finished_success("t", "r"),
    ] {
        ctx.emit(event.clone())
            .unwrap_or_else(|error| panic!("{event:?} should be accepted: {error}"));
    }
}

/// The rule that makes [`ToolCallHandle::publish_state`] usable: `STATE_*` is
/// unordered, so the work a tool does between its arguments and its result is a
/// well-formed stream. Driven through the handle rather than `emit`, because
/// the handle reaching the state is the point.
///
/// [`ToolCallHandle::publish_state`]: ag_ui::server::ToolCallHandle::publish_state
#[test]
fn a_state_delta_may_land_inside_an_open_tool_call() {
    let (mut ctx, mut events) = RunContext::<serde_json::Value>::new(RunAgentInput::new("t", "r"))
        .expect("a JSON state always decodes");
    ctx.emit(Event::run_started("t", "r"))
        .expect("the run starts");
    // Long enough that the second publish is cheaper to patch than to resend.
    ctx.set_state(&serde_json::json!({"hits": 0, "notes": "a".repeat(200)}))
        .expect("the first publish is a snapshot");

    let mut call = ctx.tool_call("search").expect("the call opens");
    call.args(r#"{"q":"rust"}"#).expect("the arguments go out");
    call.state_mut()["hits"] = serde_json::json!(1);
    call.publish_state()
        .expect("a publish inside an open call is legal");
    call.result("{}").expect("the result closes the call");

    let types: Vec<EventType> = events.drain().iter().map(Event::event_type).collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::StateSnapshot,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::StateDelta,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
        ]
    );
}

#[test]
fn content_without_a_start_is_rejected() {
    let (mut ctx, _events) = context();
    let error = ctx
        .emit(Event::text_message_content("m1", "hello"))
        .expect_err("m1 was never opened");
    assert_eq!(rule(error), Rule::NotOpen);
}

#[test]
fn an_end_without_a_start_is_rejected() {
    let (mut ctx, _events) = context();
    let error = ctx
        .emit(Event::text_message_end("m1"))
        .expect_err("m1 was never opened");
    assert_eq!(rule(error), Rule::NotOpen);
}

#[test]
fn a_duplicate_start_is_rejected() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::text_message_start("m1", TextMessageRole::Assistant))
        .expect("the first start is fine");
    let error = ctx
        .emit(Event::text_message_start("m1", TextMessageRole::Assistant))
        .expect_err("m1 is already open");
    assert_eq!(rule(error), Rule::DuplicateStart);
}

#[test]
fn a_second_run_started_is_rejected() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r"))
        .expect("the first start is fine");
    let error = ctx
        .emit(Event::run_started("t", "r"))
        .expect_err("the run already started");
    assert_eq!(rule(error), Rule::DuplicateRunStarted);
}

#[test]
fn a_stream_opens_with_run_started_or_run_error() {
    // AG-UI 1.0, "The run": a producer must not emit any other event first.
    // The upstream stream `first-event-not-run-started-fatal`.
    use ag_ui::server::EventVerifier;
    for first in [
        Event::text_message_start("m1", TextMessageRole::Assistant),
        Event::custom("early", serde_json::json!(1)),
        Event::raw(serde_json::json!({})),
        Event::run_finished_success("t", "r"),
    ] {
        let error = EventVerifier::new()
            .observe(&first)
            .expect_err("nothing but RUN_STARTED or RUN_ERROR opens a stream");
        assert_eq!(error.rule, Rule::OutOfOrder, "{first:?}");
        assert!(
            error
                .detail
                .contains("RUN_STARTED or RUN_ERROR comes first")
        );
    }

    // A run can fail before it begins.
    let mut verifier = EventVerifier::new();
    verifier.observe(&Event::run_error("unreachable")).unwrap();

    // A rejected first event does not open the stream.
    let mut verifier = EventVerifier::new();
    verifier.observe(&Event::step_started("plan")).unwrap_err();
    verifier.observe(&Event::run_started("t", "r")).unwrap();
    verifier.observe(&Event::step_started("plan")).unwrap();
}

#[test]
fn the_test_harness_stands_in_for_the_driver_that_emits_run_started() {
    // `RunContext::new` has no driver behind it, so an agent's first event is
    // accepted there, and a RUN_STARTED emitted by hand still is, once.
    let (mut ctx, _events) = context();
    ctx.emit(Event::step_started("plan"))
        .expect("the harness takes the first event");
    ctx.emit(Event::run_started("t", "r"))
        .expect("a hand-written start");
    let error = ctx
        .emit(Event::run_started("t", "r"))
        .expect_err("but not a second one");
    assert_eq!(rule(error), Rule::DuplicateRunStarted);
}

#[test]
fn finishing_with_a_message_open_is_rejected() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::text_message_start("m1", TextMessageRole::Assistant))
        .expect("start");
    let error = ctx
        .emit(Event::run_finished_success("t", "r"))
        .expect_err("m1 is still open");
    assert_eq!(rule(error), Rule::OpenAtFinish);
}

#[test]
fn finishing_with_a_step_open_is_rejected() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::step_started("plan")).expect("start");
    let error = ctx
        .emit(Event::run_finished_success("t", "r"))
        .expect_err("the step is still open");
    assert_eq!(rule(error), Rule::OpenAtFinish);
}

#[test]
fn the_error_at_finish_names_the_first_thing_that_was_opened() {
    // Whichever was opened first is the one a human is looking for, and the
    // same stream always gets the same error. Repeated, because a hash map
    // would name the right one now and then.
    let what_is_open = |events: &[Event]| {
        let (mut ctx, _events) = context();
        for event in events {
            ctx.emit(event.clone()).expect("opens");
        }
        let error = ctx
            .emit(Event::run_finished_success("t", "r"))
            .expect_err("something is open");
        let Error::Verification(violation) = error else {
            panic!("expected a verification error, got {error:?}");
        };
        assert_eq!(violation.rule, Rule::OpenAtFinish);
        violation.detail
    };
    let message = |id: &str| Event::text_message_start(id, TextMessageRole::Assistant);
    let messages = ["m-5", "m-1", "m-9", "m-3", "m-7", "m-0", "m-8", "m-2"].map(message);
    let calls = ["c-4", "c-2", "c-6"].map(|id| Event::tool_call_start(id, "search"));
    let steps = ["verify", "plan"].map(Event::step_started);
    for _ in 0..16 {
        // Within a kind: the one opened first, not the least id.
        let detail = what_is_open(&messages);
        assert!(
            detail.starts_with(r#"message "m-5" is still open"#),
            "{detail}"
        );
        // Across kinds: a message before a tool call, whichever opened first.
        let mixed: Vec<Event> = calls
            .iter()
            .chain(&steps)
            .chain(&messages)
            .cloned()
            .collect();
        let detail = what_is_open(&mixed);
        assert!(
            detail.starts_with(r#"message "m-5" is still open"#),
            "{detail}"
        );
        let detail = what_is_open(&[steps.as_slice(), calls.as_slice()].concat());
        assert!(
            detail.starts_with(r#"tool call "c-4" is still open"#),
            "{detail}"
        );
        let detail = what_is_open(&steps);
        assert!(
            detail.starts_with(r#"step "verify" is still open under the parent agent"#),
            "{detail}"
        );
    }
}

#[test]
fn run_error_may_leave_things_open() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::text_message_start("m1", TextMessageRole::Assistant))
        .expect("start");
    ctx.emit(Event::run_error("the model hung up"))
        .expect("a failed run cannot be expected to have tidied up");
}

#[test]
fn events_after_the_run_ended_are_rejected() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_finished_success("t", "r"))
        .expect("finish");
    let error = ctx
        .emit(Event::custom("late", serde_json::json!(1)))
        .expect_err("the run has ended");
    assert_eq!(rule(error), Rule::RunEnded);
}

#[test]
fn a_recorded_stream_may_carry_one_run_error_after_run_finished() {
    // AG-UI 1.0, "After a run closes": a producer MAY emit RUN_ERROR after
    // RUN_FINISHED. The upstream stream
    // `late-run-error-after-finished-run-continues`.
    use ag_ui::server::EventVerifier;
    let mut verifier = EventVerifier::new();
    for event in [
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
        Event::run_error("the transport failed while flushing"),
    ] {
        verifier.observe(&event).expect("a stream 1.0 allows");
    }
    // Nothing follows RUN_ERROR, a second one included, except the next run.
    for after in [
        Event::run_error("again"),
        Event::custom("late", serde_json::json!(1)),
        Event::run_finished_success("t", "r"),
    ] {
        let error = verifier.observe(&after).expect_err("the run has ended");
        assert_eq!(error.rule, Rule::RunEnded, "{after:?}");
    }
}

#[test]
fn a_recorded_stream_may_carry_several_runs_in_sequence() {
    // AG-UI 1.0, "After a run closes": a producer MAY emit RUN_STARTED to
    // begin a new run on the same stream, after RUN_FINISHED and after
    // RUN_ERROR. The upstream streams `two-sequential-runs-accumulate` and
    // `run-error-then-new-run-continues`.
    use ag_ui::server::EventVerifier;
    let mut verifier = EventVerifier::new();
    for event in [
        Event::run_started("t", "r-1"),
        Event::tool_call_start("c1", "search"),
        Event::tool_call_end("c1"),
        Event::run_finished_success("t", "r-1"),
        Event::run_started("t", "r-2"),
        Event::text_message_start("m1", TextMessageRole::Assistant),
        Event::step_started("plan"),
        Event::run_error("the model hung up"),
        Event::run_started("t", "r-3"),
        // A call an earlier run introduced is one this producer knows.
        Event::tool_call_result("m2", "c1", "ok"),
        // What the failed run left open ended with it.
        Event::step_started("plan"),
        Event::step_finished("plan"),
        Event::run_finished_success("t", "r-3"),
    ] {
        verifier.observe(&event).expect("a stream 1.0 allows");
    }

    // "A RUN_STARTED while a run is still active is a violation."
    verifier
        .observe(&Event::run_started("t", "r-4"))
        .expect("the next run");
    let error = verifier
        .observe(&Event::run_started("t", "r-5"))
        .expect_err("r-4 has not ended");
    assert_eq!(error.rule, Rule::DuplicateRunStarted);
    // The failed run's message is not open in the run after it.
    let error = verifier
        .observe(&Event::text_message_content("m1", "x"))
        .expect_err("m1 ended with the run that opened it");
    assert_eq!(error.rule, Rule::NotOpen);
}

#[test]
fn a_hosted_run_sends_nothing_after_its_terminal_event() {
    // The sink's own rule, with or without the verifier: what a recorded
    // stream may carry is not what a run that is over may still send.
    let (mut ctx, mut events) = context();
    ctx.emit(Event::run_finished_success("t", "r"))
        .expect("finish");
    let error = ctx
        .emit(Event::run_error("too late to say"))
        .expect_err("the run has ended");
    assert_eq!(rule(error), Rule::RunEnded);
    assert_eq!(events.drain().len(), 1, "only RUN_FINISHED went out");
}

#[test]
fn an_interrupt_outcome_names_an_interrupt() {
    // AG-UI 1.0, schema: "At least one: an interrupt outcome with nothing to
    // answer would leave a consumer with nothing to do."
    let (mut ctx, mut events) = context();
    let error = ctx
        .emit(Event::run_finished_interrupt("t", "r", Vec::new()))
        .expect_err("nothing to answer");
    assert_eq!(rule(error), Rule::InvalidOutcome);
    assert!(events.drain().is_empty(), "the event was not sent");
    // The run is still open, so it can end properly.
    ctx.emit(Event::run_finished_interrupt(
        "t",
        "r",
        vec![Interrupt::new("i1", "approval")],
    ))
    .expect("an interrupt to answer");
}

#[test]
fn a_result_for_an_unknown_call_is_rejected() {
    let (mut ctx, _events) = context();
    let error = ctx
        .emit(Event::tool_call_result("m1", "c-nope", "ok"))
        .expect_err("c-nope was never started");
    assert_eq!(rule(error), Rule::UnknownId);
}

/// The request a resumed run answers: the interrupted run's assistant message
/// opened `c1` and nothing has answered it yet. History the consumer already
/// holds is not streamed again, so the run learns it from `messages` alone.
fn resumed_input() -> RunAgentInput {
    let mut input = RunAgentInput::new("t", "r-2");
    input.messages = vec![
        Message::user("u1", "Move the funds."),
        Message::Assistant(AssistantMessage {
            id: "a1".into(),
            tool_calls: Some(vec![ToolCall::new("c1", "transfer_funds", "{}")]),
            ..Default::default()
        }),
    ];
    input.resume = Some(vec![ResumeEntry::resolved("i1", serde_json::json!(true))]);
    input
}

#[tokio::test]
async fn a_resumed_run_can_answer_a_call_an_earlier_run_opened() {
    struct Executes;

    impl Agent for Executes {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::tool_call_result("t1", "c1", "transferred"))?;
            ctx.say("Done.")?;
            Ok(RunOutcome::Success)
        }
    }

    // The input echo is optional and off by default; the history is not.
    for echo in [false, true] {
        let events: Vec<Event> = Runner::new(Executes)
            .echo_input(echo)
            .run(resumed_input())
            .collect()
            .await;
        let Some(Event::RunFinished(_)) = events.last() else {
            panic!("echo {echo}: expected RUN_FINISHED, got {events:#?}");
        };
        assert!(
            events.iter().any(|event| matches!(
                event,
                Event::ToolCallResult(result) if result.tool_call_id.as_str() == "c1"
            )),
            "echo {echo}: {events:#?}"
        );
    }
}

#[test]
fn the_test_harness_knows_the_history_too() {
    let (mut ctx, _events) =
        RunContext::<()>::new(resumed_input()).expect("an empty state always decodes");
    ctx.emit(Event::tool_call_result("t1", "c1", "transferred"))
        .expect("c1 is in the history");
    let error = ctx
        .emit(Event::tool_call_result("t2", "c-nope", "ok"))
        .expect_err("c-nope is in no history");
    assert_eq!(rule(error), Rule::UnknownId);
}

#[test]
fn a_result_before_the_call_ends_is_rejected() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::tool_call_start("c1", "search"))
        .expect("start");
    let error = ctx
        .emit(Event::tool_call_result("m1", "c1", "ok"))
        .expect_err("c1 has no TOOL_CALL_END yet");
    assert_eq!(rule(error), Rule::OutOfOrder);
}

#[test]
fn a_chunk_needs_no_bracketing() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::text_message_chunk(
        Some("m1".into()),
        Some("whole thing".to_owned()),
    ))
    .expect("a chunk opens its own message");
    ctx.emit(Event::tool_call_chunk(
        Some("c1".into()),
        Some("search".to_owned()),
        Some("{}".to_owned()),
    ))
    .expect("and the next one ends it");
    ctx.emit(Event::tool_call_result("m2", "c1", "ok"))
        .expect("a result ends the chunked call it answers");
    ctx.emit(Event::text_message_chunk(
        Some("m3".into()),
        Some("last".to_owned()),
    ))
    .expect("a chunk opens its own message");
    ctx.emit(Event::run_finished_success("t", "r"))
        .expect("RUN_FINISHED ends the chunk stream still open");
}

fn text_chunk(id: Option<&str>, delta: &str) -> Event {
    Event::text_message_chunk(id.map(ag_ui::MessageId::new), Some(delta.to_owned()))
}

#[test]
fn a_chunk_that_cannot_be_expanded_is_rejected() {
    // AG-UI 1.0, "The chunked form". The upstream streams
    // `first-chunk-missing-id-fatal`, `first-tool-chunk-missing-name-fatal`,
    // `custom-closes-chunk-stream-fatal`, `chunk-conflicting-role-fatal` and
    // `chunk-conflicting-tool-name-fatal`, which a consumer rejects: a
    // producer is told before it sends them.
    let role = |role| {
        Event::TextMessageChunk(ag_ui::TextMessageChunkEvent {
            message_id: Some("m1".into()),
            role: Some(role),
            delta: Some("x".into()),
            ..Default::default()
        })
    };
    let tool = |name: Option<&str>| {
        Event::tool_call_chunk(
            Some("c1".into()),
            name.map(str::to_owned),
            Some("{}".to_owned()),
        )
    };
    for (stream, said) in [
        (vec![text_chunk(None, "orphan")], "no message is open"),
        (vec![tool(None)], "without a toolCallName"),
        (
            vec![
                text_chunk(Some("m1"), "Half "),
                Event::custom("note", serde_json::json!(1)),
                text_chunk(None, "and half."),
            ],
            "no message is open",
        ),
        (
            vec![
                role(TextMessageRole::User),
                role(TextMessageRole::Assistant),
            ],
            "does not match the open stream's role",
        ),
        (
            vec![tool(Some("search")), tool(Some("delete"))],
            "does not match the open stream's toolCallName",
        ),
    ] {
        let (mut ctx, _events) = context();
        let (last, accepted) = stream.split_last().expect("a stream");
        for event in accepted {
            ctx.emit(event.clone()).expect("accepted");
        }
        let Error::Verification(violation) = ctx.emit(last.clone()).expect_err(said) else {
            panic!("expected a verification error");
        };
        assert_eq!(violation.rule, Rule::MalformedChunk, "{said}");
        assert_eq!(violation.event, last.event_type(), "{said}");
        assert!(violation.detail.contains(said), "{}", violation.detail);
    }
}

#[test]
fn the_chunked_and_the_explicit_form_do_not_mix_within_one_item() {
    // "An explicit event carrying an identifier a chunk stream is assembling
    // is not a continuation of it: it ends the shorthand". The local streams
    // `chunk-after-explicit-start-fatal` and
    // `explicit-content-after-chunk-fatal`.
    for (start, chunk, end) in [
        (
            Event::text_message_start("m1", TextMessageRole::Assistant),
            text_chunk(Some("m1"), "a"),
            Event::text_message_end("m1"),
        ),
        (
            Event::reasoning_message_start("m1"),
            Event::reasoning_message_chunk(Some("m1".into()), Some("a".into())),
            Event::reasoning_message_end("m1"),
        ),
    ] {
        let (mut ctx, _events) = context();
        ctx.emit(start.with_subagent_run_id("worker-a"))
            .expect("start");
        let error = ctx
            .emit(chunk.clone().with_subagent_run_id("worker-b"))
            .expect_err("another worker cannot reuse this message");
        assert_eq!(rule(error), Rule::OwnerMismatch);
        let error = ctx
            .emit(chunk.with_subagent_run_id("worker-a"))
            .expect_err("the chunk opens m1 a second time");
        assert_eq!(rule(error), Rule::DuplicateStart);
        // Neither rejected chunk changed the owner or closed the item.
        ctx.emit(end.with_subagent_run_id("worker-a"))
            .expect("still open");
    }

    for explicit in [
        Event::text_message_content("m2", "b"),
        Event::text_message_end("m2"),
    ] {
        let (mut ctx, _events) = context();
        ctx.emit(text_chunk(Some("m2"), "a")).expect("chunk");
        let error = ctx
            .emit(explicit)
            .expect_err("the chunk stream ended, and m2 with it");
        assert_eq!(rule(error), Rule::NotOpen);
        // Not sent either: the chunk stream is still there to continue.
        ctx.emit(text_chunk(None, "b")).expect("still assembling");
    }
}

#[test]
fn the_error_names_the_event_the_rule_and_the_id() {
    let (mut ctx, _events) = context();
    let error = ctx
        .emit(Event::text_message_content("m1", "hello"))
        .expect_err("m1 was never opened");
    let message = error.to_string();
    assert!(message.contains("TEXT_MESSAGE_CONTENT"), "{message}");
    assert!(message.contains("not-open"), "{message}");
    assert!(message.contains("\"m1\""), "{message}");
}

#[tokio::test]
async fn a_violation_in_a_real_run_becomes_run_error() {
    struct Sloppy;

    impl Agent for Sloppy {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::text_message_content("m1", "no start"))?;
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = run(Sloppy, RunAgentInput::new("t", "r")).collect().await;

    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("PROTOCOL_VIOLATION"));
    assert_eq!(
        events.iter().map(Event::event_type).collect::<Vec<_>>(),
        [EventType::RunStarted, EventType::RunError]
    );
}

#[tokio::test]
async fn a_run_left_open_by_a_raw_emit_still_terminates() {
    struct LeavesOpen;

    impl Agent for LeavesOpen {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            // A raw start with no handle to close it: RUN_FINISHED will be
            // rejected, and the driver must fall back to RUN_ERROR rather than
            // end the stream with nothing.
            ctx.emit(Event::text_message_start("m1", TextMessageRole::Assistant))?;
            Ok(RunOutcome::interrupt(vec![Interrupt::new("i", "why not")]))
        }
    }

    let events: Vec<Event> = run(LeavesOpen, RunAgentInput::new("t", "r"))
        .collect()
        .await;

    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("PROTOCOL_VIOLATION"));
    assert!(
        error.message.contains("open-at-finish"),
        "{}",
        error.message
    );
}

// ---- subagents ------------------------------------------------------------

/// Emits `events` in order after `RUN_STARTED` and returns the first
/// rejection, if any.
fn first_rejection(events: Vec<Event>) -> Option<(usize, Rule)> {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    for (index, event) in events.into_iter().enumerate() {
        if let Err(error) = ctx.emit(event) {
            return Some((index, rule(error)));
        }
    }
    None
}

#[test]
fn a_tagged_continuation_must_name_the_opener_but_an_untagged_one_may_not() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(
        Event::text_message_start("m1", TextMessageRole::Assistant).with_subagent_run_id("s1"),
    )
    .unwrap();

    let error = ctx
        .emit(Event::text_message_content("m1", "hi").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);

    // Attribution is optional per event, so a bare continuation is fine…
    ctx.emit(Event::text_message_content("m1", "hi")).unwrap();
    // …and so is one that agrees.
    ctx.emit(Event::text_message_end("m1").with_subagent_run_id("s1"))
        .unwrap();
}

#[test]
fn a_subagent_cannot_continue_the_parents_message() {
    assert_eq!(
        first_rejection(vec![
            Event::text_message_start("m1", TextMessageRole::Assistant),
            Event::text_message_content("m1", "hi").with_subagent_run_id("s1"),
        ]),
        Some((1, Rule::OwnerMismatch))
    );
    assert_eq!(
        first_rejection(vec![
            Event::reasoning_message_start("m1").with_subagent_run_id("s1"),
            Event::reasoning_message_end("m1").with_subagent_run_id("s2"),
        ]),
        Some((1, Rule::OwnerMismatch))
    );
}

#[test]
fn a_tool_call_belongs_to_the_message_that_carries_it() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(
        Event::text_message_start("m1", TextMessageRole::Assistant).with_subagent_run_id("s1"),
    )
    .unwrap();

    let mut start = ag_ui::ToolCallStartEvent::new("c1", "search");
    start.parent_message_id = Some("m1".into());
    let disagreeing = Event::ToolCallStart(start.clone()).with_subagent_run_id("s2");
    assert_eq!(
        rule(ctx.emit(disagreeing).unwrap_err()),
        Rule::OwnerMismatch
    );

    // Untagged: inherits the message's owner…
    ctx.emit(Event::ToolCallStart(start)).unwrap();
    // …so a continuation tagged with anyone else is a mismatch.
    let error = ctx
        .emit(Event::tool_call_args("c1", "{}").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    ctx.emit(Event::tool_call_args("c1", "{}").with_subagent_run_id("s1"))
        .unwrap();
    ctx.emit(Event::tool_call_end("c1")).unwrap();
    // A result's attribution is its own: the parent may execute a subagent's call.
    ctx.emit(Event::tool_call_result("m2", "c1", "ok")).unwrap();
}

#[test]
fn steps_are_scoped_to_the_agent_that_opened_them() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(Event::step_started("plan")).unwrap();

    let error = ctx
        .emit(Event::step_finished("plan").with_subagent_run_id("s1"))
        .unwrap_err();
    assert_eq!(
        rule(error),
        Rule::NotOpen,
        "a subagent cannot close the parent's step"
    );

    // The same name under another owner is a different step.
    ctx.emit(Event::step_started("plan").with_subagent_run_id("s1"))
        .unwrap();
    ctx.emit(Event::step_finished("plan").with_subagent_run_id("s1"))
        .unwrap();
    ctx.emit(Event::step_finished("plan")).unwrap();
}

#[test]
fn subagent_lifecycle_ids_name_one_invocation_each() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(Event::subagent_started("s1", "researcher"))
        .unwrap();

    let again = ctx
        .emit(Event::subagent_started("s1", "researcher"))
        .unwrap_err();
    assert_eq!(rule(again), Rule::DuplicateStart);

    let unknown = ctx
        .emit(Event::subagent_finished_success("s2"))
        .unwrap_err();
    assert_eq!(rule(unknown), Rule::NotOpen);

    ctx.emit(Event::subagent_finished_success("s1")).unwrap();
    let reused = ctx
        .emit(Event::subagent_started("s1", "researcher"))
        .unwrap_err();
    assert_eq!(rule(reused), Rule::DuplicateStart, "closed ids stay closed");

    let orphan = ctx
        .emit(Event::SubagentStarted(
            ag_ui::SubagentStartedEvent::new("s3", "child").with_parent_subagent("s9"),
        ))
        .unwrap_err();
    assert_eq!(
        rule(orphan),
        Rule::UnknownId,
        "a parent must have been started"
    );

    // A parent that already finished is a legal parent.
    ctx.emit(Event::SubagentStarted(
        ag_ui::SubagentStartedEvent::new("s3", "child").with_parent_subagent("s1"),
    ))
    .unwrap();
    // Attribution without an announcement is a supported mode.
    ctx.emit(Event::custom("ping", serde_json::json!(1)).with_subagent_run_id("never-announced"))
        .unwrap();
    ctx.emit(Event::subagent_error("s3", "boom")).unwrap();
    ctx.emit(Event::run_finished_success("t", "r")).unwrap();
}

#[test]
fn finishing_with_a_subagent_active_is_rejected_but_erroring_is_not() {
    assert_eq!(
        first_rejection(vec![
            Event::subagent_started("s1", "researcher"),
            Event::run_finished_success("t", "r"),
        ]),
        Some((1, Rule::OpenAtFinish))
    );
    assert_eq!(
        first_rejection(vec![
            Event::subagent_started("s1", "researcher"),
            Event::run_error("boom"),
        ]),
        None
    );
}

#[test]
fn a_messages_snapshot_seeds_ownership() {
    use ag_ui::{AssistantMessage, Message, ToolCall};

    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(Event::messages_snapshot(vec![Message::Assistant(
        AssistantMessage {
            id: "m1".into(),
            content: Some("Searching.".into()),
            tool_calls: Some(vec![ToolCall::new("c1", "search", "{}")]),
            subagent_run_id: Some("s1".into()),
            ..Default::default()
        },
    )]))
    .unwrap();

    // Re-opening under another subagent conflicts with the snapshot…
    let error = ctx
        .emit(
            Event::text_message_start("m1", TextMessageRole::Assistant).with_subagent_run_id("s2"),
        )
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    // …and so does tagging its tool call with one.
    let error = ctx
        .emit(Event::tool_call_start("c1", "search").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);

    // The call is known from the snapshot, so its result is answerable.
    ctx.emit(Event::tool_call_result("m2", "c1", "ok")).unwrap();
    // An untagged re-open is accepted, and the message keeps its owner.
    ctx.emit(Event::text_message_start("m1", TextMessageRole::Assistant))
        .unwrap();
    ctx.emit(Event::text_message_end("m1")).unwrap();
    ctx.emit(Event::run_finished_success("t", "r")).unwrap();
}

// ---- review round 1: owner semantics mirrored from upstream ---------------

#[test]
fn the_first_writer_owns_a_message_and_an_untagged_reopen_keeps_it() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(
        Event::text_message_start("m1", TextMessageRole::Assistant).with_subagent_run_id("s1"),
    )
    .unwrap();
    ctx.emit(Event::text_message_end("m1").with_subagent_run_id("s1"))
        .unwrap();

    // An untagged re-open is accepted, and does not hand m1 to the parent…
    ctx.emit(Event::text_message_start("m1", TextMessageRole::Assistant))
        .unwrap();
    // …so s1 may still continue it, and s2 still may not.
    ctx.emit(Event::text_message_content("m1", "more").with_subagent_run_id("s1"))
        .unwrap();
    let error = ctx
        .emit(Event::text_message_content("m1", "mine").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    ctx.emit(Event::text_message_end("m1")).unwrap();

    // A tool call carried by m1 is s1's, as it was before the re-open.
    let mut start = ag_ui::ToolCallStartEvent::new("c1", "search");
    start.parent_message_id = Some("m1".into());
    ctx.emit(Event::ToolCallStart(start).with_subagent_run_id("s1"))
        .unwrap();
}

#[test]
fn the_run_started_echo_seeds_ownership_without_overwriting_it() {
    use ag_ui::{AssistantMessage, Message, RunAgentInput, ToolCall};

    let mut input = RunAgentInput::new("t", "r");
    input.messages = vec![Message::Assistant(AssistantMessage {
        id: "h1".into(),
        content: Some("earlier".into()),
        tool_calls: Some(vec![ToolCall::new("hc1", "search", "{}")]),
        subagent_run_id: Some("s1".into()),
        ..Default::default()
    })];
    let mut started = ag_ui::RunStartedEvent::new("t", "r");
    started.input = Some(Box::new(input));

    // Replayed history: s2 may not re-open s1's message or continue its call.
    let (mut ctx, _events) = context();
    ctx.emit(started.clone().into()).unwrap();
    let error = ctx
        .emit(
            Event::text_message_start("h1", TextMessageRole::Assistant).with_subagent_run_id("s2"),
        )
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    let error = ctx
        .emit(Event::tool_call_start("hc1", "search").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);

    // The echo is history, not a rewrite: a snapshot that restates h1 as the
    // parent's is authoritative over it, and the parent may then re-open h1.
    let (mut ctx, _events) = context();
    ctx.emit(started.into()).unwrap();
    ctx.emit(Event::messages_snapshot(vec![Message::assistant(
        "h1", "restated",
    )]))
    .unwrap();
    ctx.emit(Event::text_message_start("h1", TextMessageRole::Assistant))
        .unwrap();
    ctx.emit(Event::text_message_end("h1")).unwrap();
    ctx.emit(Event::run_finished_success("t", "r")).unwrap();
}

#[test]
fn a_tool_result_mints_its_message_under_its_own_attribution() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(Event::tool_call_start("c1", "search")).unwrap();
    ctx.emit(Event::tool_call_end("c1")).unwrap();
    ctx.emit(Event::tool_call_result("m2", "c1", "ok")).unwrap();

    // m2 is the parent's now, so a subagent may not re-open it.
    let error = ctx
        .emit(
            Event::text_message_start("m2", TextMessageRole::Assistant).with_subagent_run_id("s1"),
        )
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
}

#[test]
fn a_reasoning_block_and_its_message_share_an_owner() {
    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(Event::reasoning_start("r1").with_subagent_run_id("s1"))
        .unwrap();
    let error = ctx
        .emit(Event::reasoning_message_start("r1").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);

    // Untagged inside the block is fine, and the block's close must agree.
    ctx.emit(Event::reasoning_message_start("r1")).unwrap();
    ctx.emit(Event::reasoning_message_end("r1")).unwrap();
    let error = ctx
        .emit(Event::reasoning_end("r1").with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    ctx.emit(Event::reasoning_end("r1").with_subagent_run_id("s1"))
        .unwrap();
}

#[test]
fn an_encrypted_value_must_name_the_owner_of_what_it_attaches_to() {
    use ag_ui::ReasoningEncryptedValueSubtype;

    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(Event::tool_call_start("c1", "search").with_subagent_run_id("s1"))
        .unwrap();
    ctx.emit(Event::tool_call_end("c1").with_subagent_run_id("s1"))
        .unwrap();
    ctx.emit(Event::reasoning_message_start("r1").with_subagent_run_id("s1"))
        .unwrap();
    ctx.emit(Event::reasoning_message_end("r1").with_subagent_run_id("s1"))
        .unwrap();

    // The subtype picks the map: a tool call's owner, then a message's.
    let error = ctx
        .emit(
            Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::ToolCall, "c1", "x")
                .with_subagent_run_id("s2"),
        )
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    let error = ctx
        .emit(
            Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, "r1", "x")
                .with_subagent_run_id("s2"),
        )
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    ctx.emit(
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, "r1", "x")
            .with_subagent_run_id("s1"),
    )
    .unwrap();
    // An untagged one agrees with anyone, and an unknown entity has no owner.
    ctx.emit(Event::reasoning_encrypted_value(
        ReasoningEncryptedValueSubtype::ToolCall,
        "c1",
        "x",
    ))
    .unwrap();
    ctx.emit(
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, "never", "x")
            .with_subagent_run_id("s2"),
    )
    .unwrap();
}

/// An activity snapshot with `replace` chosen — the factory's default is true.
fn activity(id: &str, content: ag_ui::JsonObject, replace: bool) -> Event {
    let mut event = ag_ui::ActivitySnapshotEvent::new(id, "progress", content);
    event.replace = replace;
    Event::ActivitySnapshot(event)
}

#[test]
fn an_activity_is_owned_by_its_snapshot_and_only_a_replacing_one_reowns_it() {
    use ag_ui::{JsonObject, PatchOperation};

    let (mut ctx, _events) = context();
    ctx.emit(Event::run_started("t", "r")).unwrap();
    ctx.emit(activity("a1", JsonObject::new(), true).with_subagent_run_id("s1"))
        .unwrap();

    // A delta under another subagent is rejected; untagged and s1's pass.
    let patch = vec![PatchOperation::add("/step", 1)];
    let error = ctx
        .emit(Event::activity_delta("a1", "progress", patch.clone()).with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);
    ctx.emit(Event::activity_delta("a1", "progress", patch.clone()))
        .unwrap();

    // A merge under the parent does not re-own the activity…
    ctx.emit(activity("a1", JsonObject::new(), false)).unwrap();
    let error = ctx
        .emit(Event::activity_delta("a1", "progress", patch.clone()).with_subagent_run_id("s2"))
        .unwrap_err();
    assert_eq!(rule(error), Rule::OwnerMismatch);

    // …a replacing snapshot does.
    ctx.emit(activity("a1", JsonObject::new(), true).with_subagent_run_id("s2"))
        .unwrap();
    ctx.emit(Event::activity_delta("a1", "progress", patch).with_subagent_run_id("s2"))
        .unwrap();
}
