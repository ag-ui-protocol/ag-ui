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
