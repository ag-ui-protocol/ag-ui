//! A hosted endpoint hands what decoding removed from a request to the
//! application, never to stderr.
#![cfg(feature = "axum")]

use std::sync::{Arc, Mutex};

use ag_ui::RunOutcome;
use ag_ui::axum::extract::decode_with_warnings;
use ag_ui::axum::{AgentEndpoint, RouterExt};
use ag_ui::server::{Agent, Result, RunContext};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt as _;

struct Done;

impl Agent for Done {
    type State = ();

    async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        Ok(RunOutcome::Success)
    }
}

async fn post(app: Router, body: Value) -> StatusCode {
    let request = Request::post("/agent")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    status
}

#[tokio::test]
async fn the_endpoint_hands_each_requests_warnings_to_its_hook() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let endpoint = AgentEndpoint::new(Done).on_input_warnings(move |input, warnings| {
        let run = input.run_id.as_str().to_owned();
        sink.lock().unwrap().push((run, warnings.to_vec()));
    });
    let app = Router::new().route_agui_with("/agent", endpoint);

    let noisy = json!({
        "threadId": "t", "runId": "r1", "messages": [], "futureField": true,
        "tools": [
            {"name": "a", "description": "A", "parameters": null},
            {"name": "b", "description": "B", "parameters": null}
        ]
    });
    assert_eq!(post(app.clone(), noisy).await, StatusCode::OK);
    let clean = json!({"threadId": "t", "runId": "r2", "messages": []});
    assert_eq!(post(app, clean).await, StatusCode::OK);

    let seen = seen.lock().unwrap();
    assert_eq!(
        *seen,
        [(
            "r1".to_owned(),
            vec![
                "deprecated parameters: null on a tool read as an omitted field".to_owned(),
                "unrecognised property at /futureField".to_owned(),
            ]
        )],
        "one call, for the request that had warnings"
    );
}

#[test]
fn decoding_reports_a_bounded_and_escaped_slice_of_the_body() {
    let long = "x".repeat(1 << 20);
    let mut body = json!({"threadId": "t", "runId": "r", "messages": []});
    body[&long] = json!(1);
    body["line\nbreak\u{1b}[31m"] = json!(1);
    let (input, warnings) = decode_with_warnings(&serde_json::to_vec(&body).unwrap()).unwrap();
    assert_eq!(input.run_id.as_str(), "r");
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    for warning in &warnings {
        assert!(warning.len() < 256, "{} bytes", warning.len());
        assert!(!warning.contains(char::is_control), "{warning:?}");
    }
}
