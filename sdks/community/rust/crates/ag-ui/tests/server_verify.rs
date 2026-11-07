//! One test per ordering rule, plus proof that a valid stream passes.
//!
//! The typed handles make most of these unreachable — which is the point — so
//! the violations here go through the raw [`RunContext::emit`] escape hatch.

#![cfg(feature = "server")]
#![cfg(feature = "verify")]

use ag_ui::server::{Agent, Error, EventReceiver, Result, Rule, RunContext, run};
use ag_ui::{Event, EventType, Interrupt, RunAgentInput, RunOutcome, TextMessageRole};
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
fn a_result_for_an_unknown_call_is_rejected() {
    let (mut ctx, _events) = context();
    let error = ctx
        .emit(Event::tool_call_result("m1", "c-nope", "ok"))
        .expect_err("c-nope was never started");
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
    .expect("chunks are self-contained");
    ctx.emit(Event::tool_call_chunk(
        Some("c1".into()),
        Some("search".to_owned()),
        Some("{}".to_owned()),
    ))
    .expect("chunks are self-contained");
    ctx.emit(Event::tool_call_result("m2", "c1", "ok"))
        .expect("a chunked call is a known call");
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

    let events: Vec<Event> = run(Sloppy, RunAgentInput::new("t", "r"))
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

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
        .map(|event| event.expect("the run stream should not break"))
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
