//! External-crate coverage of the supported construction and matching APIs.
use ag_ui_client::agent::{AgentConfig, RunAgentParams, RunAgentResult, RunTerminalStatus};
use ag_ui_client::sse::SseLimits;
use ag_ui_core::types::{RunId, ThreadId};
use serde_json::json;

#[test]
fn extensible_configuration_and_results_remain_constructible() {
    let mut config = AgentConfig::<serde_json::Value>::default();
    config.debug = Some(true);
    assert_eq!(config.debug, Some(true));
    let mut params = RunAgentParams::new().with_state(json!({"n": 1}));
    params.thread_id = Some(ThreadId::from("thread"));
    assert_eq!(params.state, json!({"n": 1}));
    let terminal = RunTerminalStatus::Finished {
        thread_id: ThreadId::from("thread"),
        run_id: RunId::from("run"),
    };
    let mut result = RunAgentResult::new(terminal, json!({"n": 2}));
    assert!(result.messages.is_empty());
    assert!(result.new_messages.is_empty());
    assert!(result.result.is_none());
    assert!(result.outcome.is_none());
    assert!(result.usage.is_none());
    result.result = Some(json!(false));
    assert_eq!(result.result, Some(json!(false)));
    assert_eq!(result.new_state, json!({"n": 2}));
}

#[test]
fn stream_limits_have_explicit_and_default_constructors() {
    let mut limits = SseLimits::new(100, 200);
    assert_eq!(limits.max_line_bytes, 100);
    assert_eq!(limits.max_frame_bytes, 200);
    limits.max_frame_bytes = 300;
    assert_eq!(limits.max_frame_bytes, 300);
    assert!(SseLimits::default().max_line_bytes > 0);
}

#[cfg(feature = "http")]
#[test]
fn error_body_limits_allow_zero_capture() {
    use ag_ui_client::http::ErrorBodyLimits;
    use std::time::Duration;
    let limits = ErrorBodyLimits::new(0, Duration::from_millis(10));
    assert_eq!(limits.max_bytes, 0);
    assert_eq!(limits.read_timeout, Duration::from_millis(10));
}
