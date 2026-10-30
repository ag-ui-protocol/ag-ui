//! Protocol verification: what a malformed stream should say.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{Error, Thread, Update, Verifier, verify_all};
use ag_ui::{Event, TextMessageRole};
use futures_util::StreamExt;
use serde_json::json;

/// Runs a stream through a verifier and returns the first complaint.
fn complaint(events: &[Event]) -> String {
    let mut verifier = Verifier::new();
    for event in events {
        if let Err(error) = verifier.verify(event) {
            assert!(matches!(error, Error::Protocol(_)), "unexpected: {error:?}");
            return error.to_string();
        }
    }
    panic!("expected a violation, but the stream verified");
}

#[test]
fn content_for_a_message_that_was_never_opened_is_rejected() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::text_message_content("msg-1", "orphan"),
    ]);
    assert!(said.contains("never opened"), "{said}");
    assert!(said.contains("msg-1"), "{said}");
}

#[test]
fn content_for_a_message_other_than_the_one_that_was_opened_is_rejected() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-2", "wrong message"),
    ]);
    assert!(said.contains("msg-2"), "{said}");
    assert!(said.contains("never opened"), "{said}");
}

#[test]
fn two_message_ids_may_stream_at_once() {
    // Upstream's verifier keys everything by id — `activeMessages` /
    // `activeToolCalls` are maps, not single slots — and its test file has
    // "should allow concurrent text messages with different IDs". A producer
    // that streams two answers at once is well-formed, not broken.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_start("msg-2", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "one"),
        Event::text_message_content("msg-2", "two"),
        Event::text_message_content("msg-1", " more"),
        Event::text_message_end("msg-2"),
        Event::text_message_end("msg-1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("two message ids may be open at once");
}

#[test]
fn two_tool_calls_may_stream_at_once() {
    // "should allow concurrent tool calls with different IDs" upstream, and the
    // reason it matters: every provider that supports parallel tool calling
    // interleaves the argument deltas of both.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::tool_call_start("call-1", "get_weather"),
        Event::tool_call_start("call-2", "get_time"),
        Event::tool_call_args("call-1", r#"{"city":"#),
        Event::tool_call_args("call-2", r#"{"zone":"#),
        Event::tool_call_args("call-1", r#""Seoul"}"#),
        Event::tool_call_end("call-1"),
        Event::tool_call_args("call-2", r#""KST"}"#),
        Event::tool_call_end("call-2"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("two tool call ids may be open at once");
}

#[test]
fn a_tool_call_may_open_inside_a_message() {
    // "should allow overlapping text messages and tool calls" upstream. This is
    // what an assistant turn that narrates while it calls a tool looks like.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Let me check."),
        Event::tool_call_start("call-1", "get_weather"),
        Event::tool_call_args("call-1", "{}"),
        Event::tool_call_end("call-1"),
        Event::text_message_end("msg-1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("a tool call may overlap the message that narrates it");
}

#[test]
fn the_same_message_id_cannot_open_twice() {
    // The rule concurrency replaces: not "one at a time" but "one per id".
    // Upstream: "A text message with ID 'msg-1' is already in progress."
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
    ]);
    assert!(said.contains("msg-1"), "{said}");
    assert!(said.contains("already open"), "{said}");
}

#[test]
fn the_same_tool_call_id_cannot_open_twice() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::tool_call_start("call-1", "get_weather"),
        Event::tool_call_start("call-1", "get_weather"),
    ]);
    assert!(said.contains("call-1"), "{said}");
    assert!(said.contains("already open"), "{said}");
}

#[test]
fn a_run_may_not_finish_with_any_of_several_open_messages() {
    // Concurrency does not weaken the close-before-finish rule: upstream
    // rejects RUN_FINISHED "while text messages are still active" by listing
    // whatever is left in the map.
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_start("msg-2", TextMessageRole::Assistant),
        Event::text_message_end("msg-1"),
        Event::run_finished_success("t", "r"),
    ]);
    assert!(said.contains("msg-2"), "{said}");
    assert!(said.contains("still open"), "{said}");
}

#[test]
fn tool_call_arguments_for_the_wrong_call_are_rejected() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::tool_call_start("call-1", "t"),
        Event::tool_call_args("call-2", "{}"),
    ]);
    assert!(said.contains("call-2"), "{said}");
}

#[test]
fn reasoning_content_needs_its_message_opened_first() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::reasoning_message_content("r-1", "thinking"),
    ]);
    assert!(said.contains("never opened"), "{said}");
}

#[test]
fn nothing_may_follow_a_finished_run() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
    ]);
    assert!(
        said.contains("after the run had already finished"),
        "{said}"
    );

    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::run_error("boom"),
        Event::run_finished_success("t", "r"),
    ]);
    assert!(
        said.contains("after the run had already finished"),
        "{said}"
    );
}

#[test]
fn a_run_starts_once() {
    let said = complaint(&[Event::run_started("t", "r"), Event::run_started("t", "r")]);
    assert!(said.contains("twice"), "{said}");
}

#[test]
fn the_stream_opens_with_run_started() {
    let said = complaint(&[Event::text_message_start(
        "msg-1",
        TextMessageRole::Assistant,
    )]);
    assert!(said.contains("before RUN_STARTED"), "{said}");
}

#[test]
fn raw_and_custom_events_are_outside_the_ordering_rules() {
    // Both are escape hatches by definition, including before the run starts.
    let mut verifier = Verifier::new();
    verifier
        .verify(&Event::custom("hello", json!(1)))
        .expect("custom is allowed anywhere");
    verifier
        .verify(&Event::raw(json!({ "provider": "openai" })))
        .expect("raw is allowed anywhere");
    verifier
        .verify(&Event::run_started("t", "r"))
        .expect("and the run still starts cleanly");
}

#[test]
fn a_run_may_not_finish_with_a_message_still_open() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::run_finished_success("t", "r"),
    ]);
    assert!(said.contains("still open"), "{said}");
}

#[test]
fn a_run_may_not_finish_with_a_step_still_running() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::step_started("plan"),
        Event::run_finished_success("t", "r"),
    ]);
    assert!(said.contains("still running"), "{said}");
}

#[test]
fn a_failing_run_may_abandon_what_it_had_open() {
    // Failing is exactly the case where the agent cannot close things neatly.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "half a sen"),
        Event::run_error("the model went away"),
    ])
    .expect("a run error may leave things open");
}

#[test]
fn steps_must_match_their_names() {
    let said = complaint(&[Event::run_started("t", "r"), Event::step_finished("plan")]);
    assert!(said.contains("never started"), "{said}");

    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::step_started("plan"),
        Event::step_started("plan"),
    ]);
    assert!(said.contains("already running"), "{said}");
}

#[test]
fn steps_may_nest_when_their_names_differ() {
    verify_all(&[
        Event::run_started("t", "r"),
        Event::step_started("outer"),
        Event::step_started("inner"),
        Event::step_finished("inner"),
        Event::step_finished("outer"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("nested steps are fine");
}

#[test]
fn state_and_activity_events_may_interleave_with_a_message() {
    // Deliberately looser than the TypeScript verifier: a chunk-streaming
    // producer publishes state between two fragments of one message, and
    // rejecting that would make the verifier useless in practice.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Hel"),
        Event::state_snapshot(json!({ "progress": 0.5 })),
        Event::step_started("mid-message"),
        Event::step_finished("mid-message"),
        Event::text_message_content("msg-1", "lo"),
        Event::text_message_end("msg-1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("state between fragments is legitimate");
}

#[test]
fn an_interrupt_outcome_with_no_interrupts_is_rejected() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::run_finished_interrupt("t", "r", Vec::new()),
    ]);
    assert!(said.contains("at least one interrupt"), "{said}");
}

#[test]
fn a_stream_that_stops_early_is_a_violation_of_its_own() {
    let mut verifier = Verifier::new();
    verifier.verify(&Event::run_started("t", "r")).expect("ok");
    let error = verifier.finish().expect_err("the run never finished");
    assert!(
        error.to_string().contains("ended before RUN_FINISHED"),
        "unexpected error: {error}"
    );

    // And a stream with no events at all never even started.
    let error = Verifier::new().finish().expect_err("nothing arrived");
    assert!(error.to_string().contains("ended before RUN_STARTED"));
}

#[test]
fn chunk_events_are_left_to_the_normalizer() {
    // The verifier runs after normalization, so chunks it does see are opaque
    // rather than violations.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::text_message_chunk(Some("msg-1".into()), Some("hi".into())),
        Event::run_finished_success("t", "r"),
    ])
    .expect("chunks are not an ordering violation");
}

#[tokio::test]
async fn a_thread_reports_a_malformed_stream_and_does_not_apply_it() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        // No TEXT_MESSAGE_START: this content has nowhere to go.
        Event::text_message_content("msg-1", "orphan text"),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    let errors: Vec<String> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect();

    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("never opened"), "{}", errors[0]);
    // Only the user's own message: the rejected event was not applied.
    assert_eq!(thread.messages().len(), 1);
}

#[tokio::test]
async fn a_run_that_ends_untidily_still_ends() {
    // The producer forgot TEXT_MESSAGE_END. That is worth complaining about,
    // but the run is over: a caller waiting for `Done` must not wait forever,
    // and it must hear about it exactly once.
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Unterminated."),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    let errors: Vec<String> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect();

    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("still open"), "{}", errors[0]);
    assert!(matches!(
        updates.last(),
        Some(Update::Done(ag_ui::client::RunEnd::Failed { .. }))
    ));
    assert_eq!(thread.applier().text_of("msg-1"), Some("Unterminated."));
}

#[tokio::test]
async fn verification_can_be_turned_off_for_a_producer_you_have_decided_to_live_with() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::text_message_content("msg-1", "orphan text"),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::builder(transport, "thread-1")
        .verify(false)
        .build()
        .unwrap();

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    assert!(
        !updates
            .iter()
            .any(|update| matches!(update, Update::Error(_)))
    );
    // The applier is tolerant, so the text still lands somewhere sensible.
    assert_eq!(thread.applier().text_of("msg-1"), Some("orphan text"));
}

// ---- subagents (rules 9–13) ----------------------------------------------

fn tagged(event: Event, id: &str) -> Event {
    event.with_subagent_run_id(id)
}

#[test]
fn a_tagged_continuation_must_name_the_opener() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("msg-1", TextMessageRole::Assistant),
            "s1",
        ),
        tagged(Event::text_message_content("msg-1", "hi"), "s2"),
    ]);
    assert!(said.contains("was opened by"), "{said}");
    assert!(said.contains("s1") && said.contains("s2"), "{said}");

    // A subagent may not continue the parent's message either.
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        tagged(Event::text_message_end("msg-1"), "s1"),
    ]);
    assert!(said.contains("the parent agent"), "{said}");
}

#[test]
fn an_untagged_continuation_and_an_unannounced_attribution_are_fine() {
    verify_all(&[
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("msg-1", TextMessageRole::Assistant),
            "s1",
        ),
        Event::text_message_content("msg-1", "hi"),
        tagged(Event::text_message_end("msg-1"), "s1"),
        // Attribution without lifecycle events is a supported mode.
        tagged(Event::custom("ping", json!(1)), "never-announced"),
        tagged(Event::step_started("plan"), "never-announced"),
        tagged(Event::step_finished("plan"), "never-announced"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("attribution is optional per event");
}

#[test]
fn a_tool_call_belongs_to_the_message_that_carries_it() {
    let mut start = ag_ui::ToolCallStartEvent::new("call-1", "search");
    start.parent_message_id = Some("msg-1".into());

    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("msg-1", TextMessageRole::Assistant),
            "s1",
        ),
        tagged(Event::ToolCallStart(start.clone()), "s2"),
    ]);
    assert!(said.contains("belongs to the message"), "{said}");

    // Untagged, it inherits the message's owner, so a sibling cannot continue it.
    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("msg-1", TextMessageRole::Assistant),
            "s1",
        ),
        Event::ToolCallStart(start),
        tagged(Event::tool_call_args("call-1", "{}"), "s2"),
    ]);
    assert!(said.contains("was opened by subagent \"s1\""), "{said}");
}

#[test]
fn steps_are_scoped_to_the_agent_that_opened_them() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::step_started("plan"),
        tagged(Event::step_finished("plan"), "s1"),
    ]);
    assert!(said.contains("never started under subagent"), "{said}");

    verify_all(&[
        Event::run_started("t", "r"),
        Event::step_started("plan"),
        tagged(Event::step_started("plan"), "s1"),
        tagged(Event::step_finished("plan"), "s1"),
        Event::step_finished("plan"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("the same name under two owners is two steps");
}

#[test]
fn subagent_ids_name_one_invocation_each() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::subagent_started("s1", "researcher"),
    ]);
    assert!(said.contains("already active"), "{said}");

    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::subagent_finished_success("s1"),
    ]);
    assert!(said.contains("not active"), "{said}");

    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::subagent_finished_success("s1"),
        Event::subagent_started("s1", "researcher"),
    ]);
    assert!(said.contains("already finished"), "{said}");

    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::SubagentStarted(
            ag_ui::SubagentStartedEvent::new("s2", "child").with_parent_subagent("s9"),
        ),
    ]);
    assert!(said.contains("was never started"), "{said}");

    // A finished parent is still a parent, and an error closes like a finish.
    verify_all(&[
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::subagent_finished_success("s1"),
        Event::SubagentStarted(
            ag_ui::SubagentStartedEvent::new("s2", "child").with_parent_subagent("s1"),
        ),
        Event::subagent_error("s2", "boom"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("a closed parent is a legal parent");
}

#[test]
fn a_run_may_not_finish_with_a_subagent_still_active_but_may_fail() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::run_finished_success("t", "r"),
    ]);
    assert!(said.contains("still active"), "{said}");

    verify_all(&[
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::run_error("boom"),
    ])
    .expect("an aborted run leaves subagents open");
}

#[test]
fn concurrent_subagents_interleave_under_their_own_tags() {
    verify_all(&[
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::subagent_started("s2", "researcher"),
        tagged(
            Event::text_message_start("m1", TextMessageRole::Assistant),
            "s1",
        ),
        tagged(
            Event::text_message_start("m2", TextMessageRole::Assistant),
            "s2",
        ),
        tagged(Event::text_message_content("m1", "GDP"), "s1"),
        tagged(Event::text_message_content("m2", "Population"), "s2"),
        tagged(Event::text_message_end("m2"), "s2"),
        Event::subagent_finished_success("s2"),
        tagged(Event::text_message_end("m1"), "s1"),
        Event::subagent_finished_success("s1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("two subagents may stream at once");
}

#[test]
fn a_messages_snapshot_seeds_ownership() {
    use ag_ui::{AssistantMessage, Message, ToolCall};

    let snapshot = Event::messages_snapshot(vec![Message::Assistant(AssistantMessage {
        id: "m1".into(),
        content: Some("Searching.".into()),
        tool_calls: Some(vec![ToolCall::new("c1", "search", "{}")]),
        subagent_run_id: Some("s1".into()),
        ..Default::default()
    })]);

    let said = complaint(&[
        Event::run_started("t", "r"),
        snapshot.clone(),
        tagged(
            Event::text_message_start("m1", TextMessageRole::Assistant),
            "s2",
        ),
    ]);
    assert!(said.contains("belongs to subagent \"s1\""), "{said}");

    let said = complaint(&[
        Event::run_started("t", "r"),
        snapshot.clone(),
        tagged(Event::tool_call_start("c1", "search"), "s2"),
    ]);
    assert!(
        said.contains("the call belongs to subagent \"s1\""),
        "{said}"
    );

    verify_all(&[
        Event::run_started("t", "r"),
        snapshot,
        // An untagged re-open is accepted, and the message keeps its owner.
        Event::text_message_start("m1", TextMessageRole::Assistant),
        Event::text_message_end("m1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("an untagged re-open is accepted");
}

// ---- review round 1: owner semantics mirrored from upstream ---------------

#[test]
fn the_first_writer_owns_a_message_and_an_untagged_reopen_keeps_it() {
    let mut start = ag_ui::ToolCallStartEvent::new("c1", "search");
    start.parent_message_id = Some("m1".into());

    // An untagged re-open is accepted and does not hand m1 to the parent: s1
    // may still continue it, its tool call is still s1's…
    verify_all(&[
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("m1", TextMessageRole::Assistant),
            "s1",
        ),
        tagged(Event::text_message_end("m1"), "s1"),
        Event::text_message_start("m1", TextMessageRole::Assistant),
        tagged(Event::text_message_content("m1", "more"), "s1"),
        Event::text_message_end("m1"),
        tagged(Event::ToolCallStart(start), "s1"),
        tagged(Event::tool_call_end("c1"), "s1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("the first writer stays the owner");

    // …and s2 still may not.
    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("m1", TextMessageRole::Assistant),
            "s1",
        ),
        tagged(Event::text_message_end("m1"), "s1"),
        Event::text_message_start("m1", TextMessageRole::Assistant),
        tagged(Event::text_message_content("m1", "mine"), "s2"),
    ]);
    assert!(said.contains("was opened by subagent \"s1\""), "{said}");
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
    let started = Event::RunStarted(started);

    let said = complaint(&[
        started.clone(),
        tagged(
            Event::text_message_start("h1", TextMessageRole::Assistant),
            "s2",
        ),
    ]);
    assert!(said.contains("belongs to subagent \"s1\""), "{said}");

    let said = complaint(&[
        started.clone(),
        tagged(Event::tool_call_start("hc1", "search"), "s2"),
    ]);
    assert!(
        said.contains("the call belongs to subagent \"s1\""),
        "{said}"
    );

    // A snapshot is authoritative over the echo's seed.
    verify_all(&[
        started,
        Event::messages_snapshot(vec![Message::assistant("h1", "restated")]),
        tagged(
            Event::text_message_start("h1", TextMessageRole::Assistant),
            "s2",
        ),
        tagged(Event::text_message_end("h1"), "s2"),
        Event::run_finished_success("t", "r"),
    ])
    .expect_err("the snapshot gave h1 to the parent, so s2 may not re-open it");
}

#[test]
fn a_tool_result_mints_its_message_under_its_own_attribution() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        Event::tool_call_start("c1", "search"),
        Event::tool_call_end("c1"),
        Event::tool_call_result("m2", "c1", "ok"),
        tagged(
            Event::text_message_start("m2", TextMessageRole::Assistant),
            "s1",
        ),
    ]);
    assert!(said.contains("belongs to the parent agent"), "{said}");
}

#[test]
fn a_reasoning_block_and_its_message_share_an_owner() {
    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(Event::reasoning_start("r1"), "s1"),
        tagged(Event::reasoning_message_start("r1"), "s2"),
    ]);
    assert!(said.contains("belongs to subagent \"s1\""), "{said}");

    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(Event::reasoning_start("r1"), "s1"),
        Event::reasoning_message_start("r1"),
        Event::reasoning_message_end("r1"),
        tagged(Event::reasoning_end("r1"), "s2"),
    ]);
    assert!(said.contains("was opened by subagent \"s1\""), "{said}");
}

#[test]
fn an_encrypted_value_must_name_the_owner_of_what_it_attaches_to() {
    use ag_ui::ReasoningEncryptedValueSubtype;

    let opened = [
        Event::run_started("t", "r"),
        tagged(Event::tool_call_start("c1", "search"), "s1"),
        tagged(Event::tool_call_end("c1"), "s1"),
        tagged(Event::reasoning_message_start("r1"), "s1"),
        tagged(Event::reasoning_message_end("r1"), "s1"),
    ];

    let mut events = opened.to_vec();
    events.push(tagged(
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::ToolCall, "c1", "x"),
        "s2",
    ));
    let said = complaint(&events);
    assert!(said.contains("tool call \"c1\""), "{said}");

    let mut events = opened.to_vec();
    events.push(tagged(
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, "r1", "x"),
        "s2",
    ));
    let said = complaint(&events);
    assert!(said.contains("message \"r1\""), "{said}");

    let mut events = opened.to_vec();
    events.extend([
        tagged(
            Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, "r1", "x"),
            "s1",
        ),
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::ToolCall, "c1", "x"),
        Event::run_finished_success("t", "r"),
    ]);
    verify_all(&events).expect("the owner and an absent tag both pass");
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

    let patch = || vec![PatchOperation::add("/step", 1)];
    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(activity("a1", JsonObject::new(), true), "s1"),
        tagged(Event::activity_delta("a1", "progress", patch()), "s2"),
    ]);
    assert!(said.contains("activity \"a1\""), "{said}");

    // A merge under the parent does not re-own it; a replacement does.
    let said = complaint(&[
        Event::run_started("t", "r"),
        tagged(activity("a1", JsonObject::new(), true), "s1"),
        activity("a1", JsonObject::new(), false),
        tagged(Event::activity_delta("a1", "progress", patch()), "s2"),
    ]);
    assert!(said.contains("was opened by subagent \"s1\""), "{said}");

    verify_all(&[
        Event::run_started("t", "r"),
        tagged(activity("a1", JsonObject::new(), true), "s1"),
        Event::activity_delta("a1", "progress", patch()),
        tagged(activity("a1", JsonObject::new(), true), "s2"),
        tagged(Event::activity_delta("a1", "progress", patch()), "s2"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("a replacing snapshot re-owns the activity");
}
