use super::*;
use serde_json::{Value, json};

fn event(value: Value) -> Event {
    serde_json::from_value(value).unwrap()
}
fn start(run: &str) -> Event {
    event(json!({"type":"RUN_STARTED","threadId":"thread","runId":run}))
}
fn finish(run: &str) -> Event {
    event(json!({"type":"RUN_FINISHED","threadId":"thread","runId":run}))
}
fn error() -> Event {
    event(json!({"type":"RUN_ERROR","message":"producer failure"}))
}
fn apply(state: &mut ProtocolState, event: &Event) -> Result<(), AgentError> {
    state.verify(event, &[])
}

#[test]
fn phase_transition_matrix_rejects_invalid_transitions_without_changing_phase() {
    let running = RunPhase::Running;
    let finished = RunPhase::Terminal(RunTerminalStatus::Finished {
        thread_id: "thread".into(),
        run_id: "run".into(),
    });
    let Event::RunError(failure) = error() else {
        unreachable!()
    };
    let failed = RunPhase::Terminal(RunTerminalStatus::ProducerError(failure));
    let ordinary = event(json!({"type":"CUSTOM","name":"step","value":null}));
    for (phase, allowed) in [
        (RunPhase::Idle, [true, false, true, false]),
        (running.clone(), [false, true, true, true]),
        (finished.clone(), [true, false, true, false]),
        (failed.clone(), [true, false, false, false]),
    ] {
        for (event, expected) in [start("run"), finish("run"), error(), ordinary.clone()]
            .iter()
            .zip(allowed)
        {
            let mut state = ProtocolState {
                phase: phase.clone(),
                ..Default::default()
            };
            assert_eq!(
                apply(&mut state, event).is_ok(),
                expected,
                "{phase:?}: {event:?}"
            );
            if !expected {
                assert_eq!(state.phase, phase);
            } else {
                let expected = match event {
                    Event::RunStarted(_) => &running,
                    Event::RunFinished(_) => &finished,
                    Event::RunError(_) => &failed,
                    _ => &phase,
                };
                assert_eq!(&state.phase, expected);
            }
        }
    }
}

#[test]
fn completion_derives_from_latest_phase_not_requested_identity() {
    let mut state = ProtocolState::default();
    assert!(matches!(
        state.check_completion(),
        Err(AgentError::IncompleteRun(_))
    ));
    apply(&mut state, &start("historical")).unwrap();
    assert!(state.terminal_status().is_none());
    assert!(matches!(
        state.check_completion(),
        Err(AgentError::IncompleteRun(_))
    ));
    apply(&mut state, &finish("historical")).unwrap();
    state.check_completion().unwrap();
    apply(&mut state, &error()).unwrap();
    state.check_completion().unwrap();
    apply(&mut state, &start("requested")).unwrap();
    assert!(state.terminal_status().is_none());
    apply(&mut state, &finish("requested")).unwrap();
    state.check_completion().unwrap();
}

#[test]
fn differing_identities_are_accepted_but_open_streams_cannot_finish() {
    let mut state = ProtocolState::default();
    apply(
        &mut state,
        &event(json!({"type":"RUN_STARTED","threadId":"other","runId":"run"})),
    )
    .unwrap();
    apply(&mut state, &finish("different")).unwrap();
    state.check_completion().unwrap();
    apply(&mut state, &start("run")).unwrap();
    let phase = state.phase.clone();
    apply(
        &mut state,
        &event(json!({"type":"TEXT_MESSAGE_START","messageId":"m"})),
    )
    .unwrap();
    assert!(apply(&mut state, &finish("run")).is_err());
    assert_eq!(state.phase, phase);
    apply(&mut state, &error()).unwrap();
    assert!(state.active_text.is_empty());
    apply(&mut state, &start("later")).unwrap();
    apply(&mut state, &finish("later")).unwrap();
}

#[test]
fn new_run_resets_invocation_registries_but_reseeds_retained_history() {
    let history = vec![serde_json::from_value(json!({"id":"m","role":"assistant","subagentRunId":"owner","toolCalls":[{"id":"call","type":"function","function":{"name":"f","arguments":""}}]})).unwrap()];
    let mut state = ProtocolState::new(&history);
    for run in ["first", "later"] {
        state.verify(&start(run), &history).unwrap();
        assert_eq!(state.message_owners[&"m".into()].as_deref(), Some("owner"));
        assert_eq!(state.tool_owners[&"call".into()].as_deref(), Some("owner"));
        apply(
            &mut state,
            &event(json!({"type":"SUBAGENT_STARTED","subagentRunId":"sub","name":"worker"})),
        )
        .unwrap();
        apply(
            &mut state,
            &event(json!({"type":"SUBAGENT_FINISHED","subagentRunId":"sub"})),
        )
        .unwrap();
        assert!(state.closed_subagents.contains("sub"));
        apply(&mut state, &finish(run)).unwrap();
    }
}
