#![cfg(all(feature = "http", feature = "axum"))]

use ag_ui::RunAgentInput;
use ag_ui::client::Error;
use ag_ui::client::transport::{HttpTransport, Transport};
use axum::{Router, body::Body, http::StatusCode, response::Response, routing::post};
use futures_util::{StreamExt, stream};
use std::{convert::Infallible, time::Duration};

#[tokio::test]
async fn http_transport_accepts_sse_media_type_with_case_and_parameters() {
    for content_type in [
        "text/event-stream",
        "Text/Event-Stream; charset=UTF-8",
        "TEXT/EVENT-STREAM ; charset=\"utf-8\"",
    ] {
        let body = format!(
            "data: {}\n\ndata: {}\n\n",
            serde_json::to_string(&ag_ui::Event::run_started("t", "r")).unwrap(),
            serde_json::to_string(&ag_ui::Event::run_finished_success("t", "r")).unwrap(),
        );
        let app = Router::new().route(
            "/agent",
            post(move || {
                let body = body.clone();
                async move {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", content_type)
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
        let (transport, server) = start(app).await;
        let mut events = transport.run(RunAgentInput::new("t", "r")).await.unwrap();
        assert!(matches!(
            events.next().await,
            Some(Ok(ag_ui::Event::RunStarted(_)))
        ));
        assert!(matches!(
            events.next().await,
            Some(Ok(ag_ui::Event::RunFinished(_)))
        ));
        assert!(events.next().await.is_none());
        server.abort();
    }
}

#[tokio::test]
async fn http_transport_rejects_wrong_or_missing_content_type_before_reading_body() {
    for content_type in [
        Some("application/json"),
        Some("application/vnd.ag-ui.event+proto"),
        None,
    ] {
        let app = Router::new().route(
            "/agent",
            post(move || async move {
                let mut response = Response::builder().status(StatusCode::OK);
                if let Some(content_type) = content_type {
                    response = response.header("content-type", content_type);
                }
                response
                    .body(Body::from_stream(stream::pending::<
                        Result<Vec<u8>, Infallible>,
                    >()))
                    .unwrap()
            }),
        );
        let (transport, server) = start(app).await;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            transport.run(RunAgentInput::new("t", "r")),
        )
        .await
        .expect("the client must decide from headers without waiting for body bytes");
        server.abort();
        match result {
            Err(Error::UnexpectedContentType(actual)) => {
                assert_eq!(actual, content_type.unwrap_or("<missing>"));
            }
            _ => panic!("expected an unexpected Content-Type error for {content_type:?}"),
        }
    }
}

async fn start(app: Router) -> (HttpTransport, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let transport = HttpTransport::new(format!("http://{address}/agent")).unwrap();
    (transport, server)
}
