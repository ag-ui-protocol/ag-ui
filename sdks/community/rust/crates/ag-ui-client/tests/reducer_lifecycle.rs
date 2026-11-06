mod lifecycle_support;
use ag_ui_client::agent::AgentError;
use lifecycle_support::*;
use serde_json::json;

#[tokio::test]
async fn run_input_accepts_custom_events_within_a_complete_run() {
    let result = run(vec![
        start("requested"),
        json!({"type":"CUSTOM","name":"extension","value":{"opaque":true}}),
        json!({"type":"STATE_SNAPSHOT","snapshot":{"accepted":true}}),
        finish("requested"),
    ])
    .await
    .unwrap();
    assert_eq!(result.new_state, json!({"accepted":true}));
}

#[tokio::test]
async fn run_input_rejects_state_events_without_start_or_after_terminal() {
    for mut script in [vec![], vec![start("requested"), finish("requested")]] {
        script.push(json!({"type":"STATE_SNAPSHOT","snapshot":{"invalid":true}}));
        assert!(matches!(
            run(script).await,
            Err(AgentError::Execution { .. })
        ));
    }
}
