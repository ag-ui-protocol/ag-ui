#![cfg(all(feature = "server", feature = "verify"))]

use ag_ui::{Event, RunOutcome, SubagentOutcome, TextMessageRole, server::EventVerifier};

#[test]
fn standard_empty_deltas_round_trip_and_pass_both_ordering_verifiers() {
    let events = vec![
        Event::run_started("thread", "run"),
        Event::text_message_start("message", TextMessageRole::Assistant),
        Event::text_message_content("message", ""),
        Event::text_message_end("message"),
        Event::reasoning_start("reason"),
        Event::reasoning_message_start("reason"),
        Event::reasoning_message_content("reason", ""),
        Event::reasoning_message_end("reason"),
        Event::reasoning_end("reason"),
        Event::run_finished("thread", "run"),
    ];
    let mut verifier = EventVerifier::new();
    for event in &events {
        let wire = serde_json::to_value(event).unwrap();
        assert_eq!(serde_json::from_value::<Event>(wire).unwrap(), *event);
        verifier.observe(event).unwrap();
    }
    #[cfg(feature = "client")]
    ag_ui::client::verify::verify_all(&events).unwrap();
}

#[test]
fn interleaved_streams_and_interrupts_do_not_require_host_presentation_policy() {
    let mut verifier = EventVerifier::new();
    verifier
        .observe(&Event::run_started("thread", "run"))
        .unwrap();
    for id in ["first", "second"] {
        verifier
            .observe(&Event::text_message_start(id, TextMessageRole::Assistant))
            .unwrap();
    }
    for id in ["second", "first"] {
        verifier.observe(&Event::text_message_end(id)).unwrap();
    }
    verifier
        .observe(
            &ag_ui::RunFinishedEvent::new("thread", "run")
                .with_outcome(RunOutcome::interrupt(vec![ag_ui::Interrupt::new(
                    "approval", "tool",
                )]))
                .into(),
        )
        .unwrap();
}

/// A run with something of every kind open half way through.
fn half_open_run() -> (Vec<Event>, Vec<Event>) {
    let helper = |event: Event| event.with_subagent_run_id("child");
    let sent = vec![
        Event::run_started("thread", "run"),
        Event::step_started("plan"),
        Event::subagent_started("child", "helper"),
        helper(Event::text_message_start(
            "message",
            TextMessageRole::Assistant,
        )),
        helper(Event::text_message_content("message", "half")),
        Event::reasoning_start("reason"),
        Event::tool_call_chunk(Some("call".into()), Some("search".into()), None),
    ];
    let rest = vec![
        Event::tool_call_chunk(None, None, Some("{}".into())),
        // In the parent's lane, so it ends the call the chunks were opening.
        Event::reasoning_end("reason"),
        helper(Event::text_message_end("message")),
        Event::subagent_finished_success("child"),
        Event::tool_call_result("result", "call", "ok"),
        Event::step_finished("plan"),
        Event::run_finished_success("thread", "run"),
    ];
    (sent, rest)
}

#[test]
fn a_replayed_verifier_carries_on_from_where_the_run_is() {
    let (sent, rest) = half_open_run();
    let mut replayed = EventVerifier::new();
    replayed.replay(&sent).unwrap();

    // It rejects what the verifier that saw the events sent would, and
    // takes the rest of the run.
    let again = replayed
        .observe(&Event::run_started("thread", "run"))
        .unwrap_err();
    assert_eq!(again.rule, ag_ui::server::Rule::DuplicateRunStarted);
    let early = replayed
        .observe(&Event::run_finished_success("thread", "run"))
        .unwrap_err();
    assert_eq!(early.rule, ag_ui::server::Rule::OpenAtFinish);
    let stranger = Event::text_message_content("message", "x").with_subagent_run_id("other");
    assert_eq!(
        replayed.observe(&stranger).unwrap_err().rule,
        ag_ui::server::Rule::OwnerMismatch,
        "who opened what is part of where the run is"
    );
    replayed.replay(&rest).unwrap();
}

#[test]
fn a_replay_stops_at_the_event_that_breaks_a_rule_and_keeps_what_came_before() {
    let mut verifier = EventVerifier::new();
    let stored = [
        Event::run_started("thread", "run"),
        Event::text_message_start("message", TextMessageRole::Assistant),
        Event::text_message_content("other", "never opened"),
        Event::text_message_end("message"),
    ];
    let error = verifier.replay(&stored).unwrap_err();
    assert_eq!(error.event, ag_ui::EventType::TextMessageContent);
    assert_eq!(error.rule, ag_ui::server::Rule::NotOpen);
    // `message` is open: the two events before the bad one were observed,
    // and the one after it was not.
    verifier.observe(&stored[3]).unwrap();

    // Nothing replayed is nothing observed: the run has not started.
    let mut fresh = EventVerifier::new();
    fresh.replay(&[]).unwrap();
    assert_eq!(
        fresh.observe(&stored[1]).unwrap_err().rule,
        ag_ui::server::Rule::OutOfOrder
    );
}

#[test]
fn a_seeded_verifier_knows_the_calls_and_owners_of_the_history() {
    let history = [ag_ui::Message::Assistant(ag_ui::AssistantMessage {
        id: "earlier".into(),
        tool_calls: Some(vec![ag_ui::ToolCall::new("asked", "search", "{}")]),
        subagent_run_id: Some("child".into()),
        ..Default::default()
    })];
    let stored = [
        Event::run_started("thread", "run"),
        Event::tool_call_result("answer", "asked", "ok"),
    ];

    let unseeded = EventVerifier::new().replay(&stored).unwrap_err();
    assert_eq!(unseeded.rule, ag_ui::server::Rule::UnknownId);

    let mut verifier = EventVerifier::new();
    verifier.seed(&history);
    verifier.replay(&stored).unwrap();
    let reopened = Event::text_message_start("earlier", TextMessageRole::Assistant)
        .with_subagent_run_id("someone-else");
    assert_eq!(
        verifier.observe(&reopened).unwrap_err().rule,
        ag_ui::server::Rule::OwnerMismatch
    );
}

#[test]
fn a_verifier_rejects_open_subagents_without_synthesizing_their_outcome() {
    let mut verifier = EventVerifier::new();
    verifier
        .observe(&Event::run_started("thread", "run"))
        .unwrap();
    verifier
        .observe(&ag_ui::SubagentStartedEvent::new("child", "agent").into())
        .unwrap();
    let error = verifier
        .observe(&Event::run_finished("thread", "run"))
        .unwrap_err();
    assert_eq!(error.rule, ag_ui::server::Rule::OpenAtFinish);
    let mut preview = verifier.clone();
    preview
        .observe(
            &ag_ui::SubagentFinishedEvent::new("child")
                .with_outcome(SubagentOutcome::Success)
                .into(),
        )
        .unwrap();
    preview
        .observe(&Event::run_finished("thread", "run"))
        .unwrap();
    assert!(
        verifier
            .observe(&Event::run_finished("thread", "run"))
            .is_err()
    );
}
