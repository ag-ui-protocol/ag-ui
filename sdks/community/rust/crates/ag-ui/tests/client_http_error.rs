#![cfg(all(feature = "http", feature = "axum"))]

use ag_ui::RunAgentInput;
use ag_ui::client::Error;
use ag_ui::client::transport::{HttpTransport, Transport};
use axum::{Router, body::Body, http::StatusCode, response::Response, routing::post};
use futures_util::{StreamExt, stream};
use std::{convert::Infallible, time::Duration};

#[tokio::test]
async fn an_error_body_is_bounded_without_waiting_for_eof() {
    let app = Router::new().route(
        "/agent",
        post(|| async {
            let body = stream::once(async { Ok::<_, Infallible>(vec![b'x'; 4096]) })
                .chain(stream::pending());
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from_stream(body))
                .unwrap()
        }),
    );
    let (status, body) = error_response(app).await;
    assert_eq!(status, 502);
    assert_eq!(body, "x".repeat(2048));
}

#[tokio::test]
async fn an_error_body_limit_counts_bytes_and_tolerates_partial_utf8() {
    let app = Router::new().route(
        "/agent",
        post(|| async { (StatusCode::BAD_GATEWAY, "\u{d55c}".repeat(1000)) }),
    );
    let (status, body) = error_response(app).await;
    assert_eq!(status, 502);
    assert_eq!(body, format!("{}\u{fffd}", "\u{d55c}".repeat(682)));
}

#[tokio::test]
async fn a_short_error_body_is_preserved() {
    let app = Router::new().route(
        "/agent",
        post(|| async {
            (
                StatusCode::UNAUTHORIZED,
                "Access denied: \u{c778}\u{c99d} \u{d544}\u{c694}",
            )
        }),
    );
    let (status, body) = error_response(app).await;
    assert_eq!(status, 401);
    assert_eq!(body, "Access denied: \u{c778}\u{c99d} \u{d544}\u{c694}");
}

async fn error_response(app: Router) -> (u16, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let transport = HttpTransport::new(format!("http://{address}/agent")).unwrap();
    let input: RunAgentInput = serde_json::from_value(serde_json::json!({
        "threadId":"t", "runId":"r", "state":{}, "messages":[],
        "tools":[], "context":[], "forwardedProps":{}
    }))
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), transport.run(input)).await;
    server.abort();
    match result.expect("the client must not wait for an unbounded error body") {
        Err(Error::Http { status, body }) => (status, body),
        _ => panic!("expected an HTTP error"),
    }
}
