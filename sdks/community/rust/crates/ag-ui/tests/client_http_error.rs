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
        Err(Error::Http { status, body }) => {
            assert_eq!(status, 502);
            assert_eq!(body, "x".repeat(2048));
        }
        _ => panic!("expected an HTTP error"),
    }
}
