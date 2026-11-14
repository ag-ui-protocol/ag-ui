#[path = "support/http.rs"]
mod http;
use ag_ui_client::core::{
    event::Event,
    processing::DiagnosticCategory,
    types::{FunctionCall, Message, RunAgentInput, ToolCall},
};
use ag_ui_client::error::{AgUiClientError, ErrorBodyStopReason};
use ag_ui_client::http::ErrorBodyLimits;
use ag_ui_client::sse::SseLimits;
use ag_ui_client::{Agent, HttpAgent};
use futures::StreamExt;
use http::{Request, TEST_TIMEOUT};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

fn input() -> RunAgentInput {
    RunAgentInput::new(
        "thread",
        "run",
        Value::Null,
        vec![],
        vec![],
        vec![],
        Value::Null,
    )
}

fn encoded(events: &[Value]) -> Vec<u8> {
    let mut result = ag_ui_encoder::keepalive("heartbeat").unwrap();
    for event in events {
        let event: Event = serde_json::from_value(event.clone()).unwrap();
        result.extend(ag_ui_encoder::encode_live(&event).unwrap());
    }
    result
}

fn complete() -> Vec<u8> {
    encoded(&[
        json!({"type":"RUN_STARTED","threadId":"thread","runId":"run"}),
        json!({"type":"CUSTOM","name":"unicode","value":"Hello 😺 世界\nnext line"}),
        json!({"type":"RUN_FINISHED","threadId":"thread","runId":"run","outcome":{"type":"success"}}),
    ])
}

async fn server(
    status: u16,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> (
    String,
    oneshot::Receiver<Request>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let content_type = content_type.map(str::to_owned);
    let (captured, capture) = oneshot::channel();
    let task = tokio::spawn(async move {
        tokio::time::timeout(TEST_TIMEOUT, async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = http::read(&mut socket).await.expect("complete actual HTTP request");
            captured.send(request).unwrap();
            let content_type = content_type
                .map(|value| format!("Content-Type: {value}\r\n"))
                .unwrap_or_default();
            let header = format!(
                "HTTP/1.1 {status} Test\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            // TCP writes are integration evidence only; deterministic partitions are in sse_decoder.
            for chunk in body.chunks(7) {
                socket.write_all(chunk).await.unwrap();
            }
        }).await.expect("fixture server timed out")
    });
    (url, capture, task)
}

#[tokio::test]
async fn raw_and_lifecycle_share_exact_egress_projection_and_negotiation() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        for lifecycle in [false, true] {
            let (url, capture, task) = server(
                200,
                Some("TeXt/EvEnT-StReAm; charset=\"utf-8\"; example=ok"),
                complete(),
            )
            .await;
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .with_header("Accept", "application/x-protobuf")
                .unwrap()
                .with_header("Content-Type", "text/plain")
                .unwrap()
                .with_bearer_token("dummy-transport-test-only")
                .unwrap()
                .build()
                .unwrap();
            let mut request = input();
            request.messages = vec![
                serde_json::from_value(json!({"id":"u","role":"user","content":[{"type":"text","text":"hello"}],"metadata":{"nested":null}})).unwrap(),
                serde_json::from_value(json!({"id":"a","role":"activity","activityType":"progress","content":{"progress":42}})).unwrap(),
            ];
            request.forwarded_props = json!({"nested":null,"private":"preserve"});
            request.parent_run_id = Some("parent".into());
            request.context = Some(vec![
                serde_json::from_value(json!({"description":"location","value":"offline"})).unwrap(),
            ]);
            if lifecycle {
                let result = agent.run_input(&request, ()).await.unwrap();
                assert!(
                    result
                        .messages
                        .iter()
                        .any(|message| message.id().as_ref() == "a"),
                    "application activity is retained"
                );
                assert_eq!(result.new_state, json!({}));
            } else {
                let events: Vec<_> = agent.run(&request).await.unwrap().collect().await;
                assert_eq!(events.len(), 3);
                assert!(events.iter().all(Result::is_ok));
                assert_eq!(
                    serde_json::to_value(events[1].as_ref().unwrap()).unwrap()["value"],
                    "Hello 😺 世界\nnext line"
                );
            }
            let captured = capture.await.unwrap();
            assert_eq!(captured.headers["accept"], "text/event-stream");
            assert_eq!(captured.headers["content-type"], "application/json");
            assert_eq!(captured.headers["authorization"], "Bearer dummy-transport-test-only");
            assert_eq!(captured.body, serde_json::to_vec(&ag_ui_client::core::processing::prepare_run_input(&request).unwrap().input).unwrap());
            let body: Value = serde_json::from_slice(&captured.body).unwrap();
            assert_eq!(body["protocolVersion"], "1.0");
            assert!(body.get("state").is_none());
            assert_eq!(body["messages"].as_array().unwrap().len(), 1);
            assert_eq!(
                body["messages"][0]["metadata"],
                json!({"nested":null})
            );
            assert_eq!(body["forwardedProps"], request.forwarded_props);
            assert_eq!(body["parentRunId"], "parent");
            assert_eq!(
                body["context"],
                json!([{"description":"location","value":"offline"}])
            );
            assert_eq!(request.messages.len(), 2);
            assert_eq!(request.protocol_version, None);
            task.await.unwrap();
        }
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn invalid_constructed_input_fails_before_any_request_for_both_routes() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        for lifecycle in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let agent = HttpAgent::builder()
                .with_url_str(&format!("http://{}", listener.local_addr().unwrap()))
                .unwrap()
                .build()
                .unwrap();
            let mut request = input();
            let mut call = ToolCall::new("call", FunctionCall::new("tool".into(), "{}".into()));
            call.call_type = "invalid-known-arm".into();
            let mut message = Message::new_assistant("");
            if let Message::Assistant { tool_calls, .. } = &mut message {
                *tool_calls = Some(vec![call]);
            }
            request.messages = vec![message];
            let error = if lifecycle {
                agent.run_input(&request, ()).await.err().unwrap()
            } else {
                agent.run(&request).await.err().unwrap()
            };
            assert!(matches!(error, AgUiClientError::Processing(_)), "{error:?}");
            // No timing assertion: a completed eager TCP connect would be in this accept queue.
            assert!(
                tokio::time::timeout(Duration::ZERO, listener.accept())
                    .await
                    .is_err()
            );
        }
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn success_requires_exact_mime_not_a_substring_and_errors_take_precedence() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        for content_type in [
            None,
            Some("application/json"),
            Some("text/event-streamish"),
            Some("application/text/event-stream"),
            Some("text/event-stream; broken"),
        ] {
            let (url, capture, task) = server(200, content_type, Vec::new()).await;
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .build()
                .unwrap();
            assert!(
                matches!(
                    agent.run(&input()).await,
                    Err(AgUiClientError::UnexpectedContentType)
                ),
                "{content_type:?}"
            );
            capture.await.unwrap();
            task.await.unwrap();
        }
        let (url, capture, task) = server(
            401,
            Some("text/html"),
            b"<html>Bearer secret-request-value</html>".to_vec(),
        )
        .await;
        let agent = HttpAgent::builder()
            .with_url_str(&url)
            .unwrap()
            .build()
            .unwrap();
        let error = agent.run(&input()).await.err().unwrap();
        assert!(matches!(error, AgUiClientError::HttpStatus { .. }));
        let body = error.http_error_body().unwrap();
        assert_eq!(body.bytes(), b"<html>Bearer secret-request-value</html>");
        assert_eq!(
            body.text().unwrap(),
            "<html>Bearer secret-request-value</html>"
        );
        assert_eq!(body.stop_reason(), ErrorBodyStopReason::Complete);
        assert!(!body.is_truncated());
        for formatted in [
            format!("{error}"),
            format!("{error:?}"),
            format!("{error:#?}"),
            format!("{body}"),
            format!("{body:?}"),
        ] {
            assert!(!formatted.contains("secret-request-value"));
        }
        capture.await.unwrap();
        task.await.unwrap();
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn malformed_json_utf8_oversize_and_trailing_truncation_fail() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let cases = [
            (b"data: not-json\n\n".to_vec(), "json"),
            (b"data: \xff\n\n".to_vec(), "utf8"),
            (b"data: \xf0\x9f".to_vec(), "utf8"),
            (b"data: {".to_vec(), "truncated"),
            (
                [complete(), b"data: trailing".to_vec()].concat(),
                "truncated",
            ),
        ];
        for (bytes, kind) in cases {
            let (url, capture, task) = server(200, Some("text/event-stream"), bytes).await;
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .build()
                .unwrap();
            let events: Vec<_> = agent.run(&input()).await.unwrap().collect().await;
            let error = events.last().unwrap().as_ref().err().unwrap();
            match kind {
                "json" => assert!(matches!(error, AgUiClientError::Json(_))),
                "utf8" => assert!(matches!(error, AgUiClientError::SseInvalidUtf8 { .. })),
                _ => assert!(matches!(error, AgUiClientError::SseTruncated)),
            }
            capture.await.unwrap();
            task.await.unwrap();
        }
        let (url, capture, task) = server(
            200,
            Some("text/event-stream"),
            b"data: too-large\n\n".to_vec(),
        )
        .await;
        let agent = HttpAgent::builder()
            .with_url_str(&url)
            .unwrap()
            .with_sse_limits(SseLimits {
                max_line_bytes: 7,
                max_frame_bytes: 8,
            })
            .build()
            .unwrap();
        let request = input();
        let mut events = agent.run(&request).await.unwrap();
        assert!(matches!(
            events.next().await,
            Some(Err(AgUiClientError::SseLimitExceeded { .. }))
        ));
        capture.await.unwrap();
        task.await.unwrap();
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn diagnostics_are_structured_and_canonical_events_keep_patch_extensions() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        // Deliberately adversarial traffic bypasses the producer encoder.
        let bytes = [
            json!({"type":"FUTURE_EVENT","secret":"never included"}),
            json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"progress","patch":[{"op":"future","path":"/x"},{"op":"add","path":"/x","value":null,"extension":{"nested":null}}],"futureField":"never included"}),
        ].into_iter().map(|value| format!("data: {value}\n\n")).collect::<String>().into_bytes();
        let (url, capture, task) = server(200, Some("text/event-stream"), bytes).await;
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let recorded = diagnostics.clone();
        let agent = HttpAgent::builder()
            .with_url_str(&url)
            .unwrap()
            .with_diagnostic_handler(move |diagnostic| {
                recorded.lock().unwrap().push(diagnostic.clone())
            })
            .build()
            .unwrap();
        let events: Vec<_> = agent.run(&input()).await.unwrap().collect().await;
        assert_eq!(events.len(), 1);
        let value = serde_json::to_value(events[0].as_ref().unwrap()).unwrap();
        assert_eq!(
            value["patch"],
            json!([{"op":"add","path":"/x","value":null,"extension":{"nested":null}}])
        );
        let diagnostics = diagnostics.lock().unwrap().clone();
        assert!(
            diagnostics
                .iter()
                .any(|d| d.category == DiagnosticCategory::UnknownVariant && d.path == "/type")
        );
        assert!(diagnostics.iter().any(|d| d.path == "/patch/0/op"));
        assert!(diagnostics.iter().any(|d| d.path == "/futureField"));
        assert!(!format!("{diagnostics:?}").contains("never included"));
        capture.await.unwrap();
        task.await.unwrap();
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn non_success_receipt_has_byte_and_deadline_bounds_and_releases_connection() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        for send_body in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let (closed, closed_rx) = oneshot::channel();
            let server = tokio::spawn(async move {
                tokio::time::timeout(TEST_TIMEOUT, async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    http::read(&mut socket)
                        .await
                        .expect("complete actual HTTP request");
                    socket
                        .write_all(b"HTTP/1.1 503 Test\r\nContent-Length: 1000000\r\n\r\n")
                        .await
                        .unwrap();
                    if send_body {
                        socket.write_all(&vec![b's'; 4096]).await.unwrap();
                    }
                    let mut byte = [0];
                    let result = tokio::time::timeout(TEST_TIMEOUT, socket.read(&mut byte))
                        .await
                        .unwrap();
                    closed.send(matches!(result, Ok(0) | Err(_))).unwrap();
                })
                .await
                .expect("fixture server timed out")
            });
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .with_error_body_limits(ErrorBodyLimits {
                    max_bytes: 64,
                    read_timeout: Duration::from_millis(30),
                })
                .build()
                .unwrap();
            let error = tokio::time::timeout(TEST_TIMEOUT, agent.run(&input()))
                .await
                .unwrap()
                .err()
                .unwrap();
            let AgUiClientError::HttpStatus { context, body, .. } = error else {
                panic!("expected status");
            };
            assert!(body.is_truncated());
            if send_body {
                assert_eq!(body.bytes(), &[b's'; 64]);
                assert_eq!(body.stop_reason(), ErrorBodyStopReason::ByteLimit);
                assert!(
                    context.contains("inspected 64 bytes; byte limit reached"),
                    "{context}"
                );
            } else {
                assert!(body.bytes().is_empty());
                assert_eq!(body.stop_reason(), ErrorBodyStopReason::ReadTimeout);
                assert!(
                    context.contains("inspected 0 bytes; read deadline reached"),
                    "{context}"
                );
            }
            assert!(
                closed_rx.await.unwrap(),
                "partially consumed response must release the connection"
            );
            server.await.unwrap();
        }
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn dropping_active_stream_releases_http_resources_and_short_body_is_an_error() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (closed, closed_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::time::timeout(TEST_TIMEOUT, async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                http::read(&mut socket).await.expect("complete actual HTTP request");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                let body = encoded(&[json!({"type":"RUN_STARTED","threadId":"thread","runId":"run"})]);
                socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
                socket.write_all(b"\r\n").await.unwrap();
                let mut byte = [0];
                let result = tokio::time::timeout(TEST_TIMEOUT, socket.read(&mut byte))
                    .await
                    .unwrap();
                closed.send(matches!(result, Ok(0) | Err(_))).unwrap();
            }).await.expect("fixture server timed out")
        });
        let agent = HttpAgent::builder()
            .with_url_str(&url)
            .unwrap()
            .build()
            .unwrap();
        let request = input();
        let mut stream = agent.run(&request).await.unwrap();
        assert!(stream.next().await.unwrap().is_ok());
        drop(stream);
        assert!(closed_rx.await.unwrap());
        task.await.unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let agent = HttpAgent::builder()
            .with_url_str(&format!("http://{}", listener.local_addr().unwrap()))
            .unwrap()
            .build()
            .unwrap();
        let task = tokio::spawn(async move {
            tokio::time::timeout(TEST_TIMEOUT, async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                http::read(&mut socket).await.expect("complete actual HTTP request");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 999\r\n\r\ndata: {").await.unwrap();
            }).await.expect("fixture server timed out")
        });
        let events: Vec<_> = agent.run(&input()).await.unwrap().collect().await;
        assert!(matches!(
            events.last(),
            Some(Err(AgUiClientError::StreamingTransport(_)))
        ));
        task.await.unwrap();
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn configuration_and_transport_errors_do_not_expose_credentials() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let secret = "private-test-token\r\ninjected";
        let error = HttpAgent::builder()
            .with_bearer_token(secret)
            .err()
            .unwrap();
        assert!(!format!("{error:?} {error}").contains("private-test-token"));
        let error = HttpAgent::builder()
            .with_header("invalid\nname", secret)
            .err()
            .unwrap();
        assert!(!format!("{error:?} {error}").contains("private-test-token"));
        let error = HttpAgent::builder()
            .with_url_str("http://[?secret=private-test-token")
            .err()
            .unwrap();
        assert!(!format!("{error:?} {error}").contains("private-test-token"));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let agent = HttpAgent::builder()
            .with_url_str(&format!("http://{addr}/?token=private-test-token"))
            .unwrap()
            .build()
            .unwrap();
        let error = agent.run(&input()).await.err().unwrap();
        assert!(!format!("{error:?} {error}").contains("private-test-token"));
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn delayed_chunked_unicode_is_reassembled_without_fabricating_an_early_event() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let agent = HttpAgent::builder()
            .with_url_str(&format!("http://{}", listener.local_addr().unwrap()))
            .unwrap()
            .build()
            .unwrap();
        let (prefix_sent, prefix_ready) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::time::timeout(TEST_TIMEOUT, async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                http::read(&mut socket).await.expect("complete actual HTTP request");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                let body = encoded(&[json!({"type":"CUSTOM","name":"delayed","value":"😺"})]);
                let split = body
                    .windows(4)
                    .position(|bytes| bytes == "😺".as_bytes())
                    .unwrap()
                    + 2;
                socket
                    .write_all(format!("{split:x}\r\n").as_bytes())
                    .await
                    .unwrap();
                socket.write_all(&body[..split]).await.unwrap();
                socket.write_all(b"\r\n").await.unwrap();
                prefix_sent.send(()).unwrap();
                released.await.unwrap();
                socket
                    .write_all(format!("{:x}\r\n", body.len() - split).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(&body[split..]).await.unwrap();
                socket.write_all(b"\r\n0\r\n\r\n").await.unwrap();
            }).await.expect("fixture server timed out")
        });
        let request = input();
        let mut stream = agent.run(&request).await.unwrap();
        prefix_ready.await.unwrap();
        use futures::FutureExt;
        assert!(stream.next().now_or_never().is_none());
        release.send(()).unwrap();
        let event = stream.next().await.unwrap().unwrap();
        assert_eq!(serde_json::to_value(event).unwrap()["value"], "😺");
        assert!(stream.next().await.is_none());
        task.await.unwrap();
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn terminal_parse_errors_release_source_even_when_raw_stream_is_retained() {
    // One deadline covers client execution, notifications, captures, and server joins.
    tokio::time::timeout(TEST_TIMEOUT, async {
        for body in [
            b"data: not-json\n\n".as_slice(),
            b"data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m\"}\n\n",
            b"data: \xff\n\n",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let agent = HttpAgent::builder()
                .with_url_str(&format!("http://{}", listener.local_addr().unwrap()))
                .unwrap()
                .build()
                .unwrap();
            let (closed, closed_rx) = oneshot::channel();
            let body = body.to_vec();
            let task = tokio::spawn(async move {
            tokio::time::timeout(TEST_TIMEOUT, async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                http::read(&mut socket).await.expect("complete actual HTTP request");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
                socket.write_all(b"\r\n").await.unwrap();
                let mut byte = [0];
                let result = tokio::time::timeout(TEST_TIMEOUT, socket.read(&mut byte))
                    .await
                    .unwrap();
                closed.send(matches!(result, Ok(0) | Err(_))).unwrap();
            }).await.expect("fixture server timed out")
        });
            let request = input();
            let mut stream = agent.run(&request).await.unwrap();
            assert!(stream.next().await.unwrap().is_err());
            assert!(closed_rx.await.unwrap());
            assert!(stream.next().await.is_none());
            task.await.unwrap();
        }
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn stalled_response_is_bounded_and_fixture_server_is_joined() {
    tokio::time::timeout(TEST_TIMEOUT, async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let (captured, capture) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            tokio::time::timeout(TEST_TIMEOUT, async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = http::read(&mut socket).await.unwrap();
                captured.send(request).unwrap();
                // Deliberately leave response headers pending until cancellation.
                released.await.unwrap();
                drop(socket);
            }).await.expect("fixture server timed out")
        });
        let agent = HttpAgent::builder().with_url_str(&url).unwrap().build().unwrap();
        let request = input();
        let execution = agent.run(&request);
        tokio::pin!(execution);
        tokio::select! {
            result = &mut execution => panic!("stalled response unexpectedly completed: {}", result.is_ok()),
            captured = capture => { assert!(!captured.unwrap().body.is_empty()); }
        }
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut execution).await.is_err());
        release.send(()).unwrap();
        server.await.expect("fixture server failed");
    }).await.expect("fixture client or server join timed out");
}

#[tokio::test]
async fn deadline_after_streaming_starts_is_not_retryable() {
    tokio::time::timeout(TEST_TIMEOUT, async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = http::read(&mut socket).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"RUN_STARTED\",\"threadId\":\"thread\",\"runId\":\"run\"}\n\n").await.unwrap();
            tokio::time::sleep(Duration::from_millis(1500)).await;
        });
        let agent = HttpAgent::builder().with_url_str(&url).unwrap().with_timeout(1).build().unwrap();
        let request = input();
        let mut stream = agent.run(&request).await.unwrap();
        assert!(matches!(stream.next().await.unwrap().unwrap(), Event::RunStarted(_)));
        let error = stream.next().await.unwrap().unwrap_err();
        assert!(matches!(error, AgUiClientError::StreamingTransport(_)));
        assert!(!error.is_retryable());
        task.await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn recorded_maf_optional_null_streams_reach_lifecycle_completion() {
    // Recorded producer data from the independent TypeScript compatibility test.
    // Do not use our encoder: it would erase the explicit nulls under test.
    let recordings: Value =
        serde_json::from_str(include_str!("fixtures/maf_optional_nulls.json")).unwrap();
    for (name, events) in recordings.as_object().unwrap() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let body = events
                .as_array()
                .unwrap()
                .iter()
                .map(|v| format!("data: {v}\n\n"))
                .collect::<String>()
                .into_bytes();
            let (url, capture, task) = server(200, Some("text/event-stream"), body).await;
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .build()
                .unwrap();
            let mut request = input();
            request.thread_id = "t1".into();
            request.run_id = "r1".into();
            let result = agent.run_input(&request, ()).await.unwrap();
            match name.as_str() {
                "AGENTIC_CHAT" => assert_eq!(
                    result.messages[0].content(),
                    Some("Hello duaa! How can I assist you today?")
                ),
                "BACKEND_TOOL" => assert!(
                    result
                        .messages
                        .iter()
                        .any(|m| m.role() == ag_ui_client::core::types::Role::Tool)
                ),
                "RUN_ERROR" => assert!(matches!(
                    result.terminal_status,
                    ag_ui_client::RunTerminalStatus::ProducerError(_)
                )),
                _ => unreachable!(),
            }
            capture.await.unwrap();
            task.await.unwrap();
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn error_body_capture_preserves_bytes_and_handles_zero_and_exact_limits() {
    tokio::time::timeout(TEST_TIMEOUT, async {
        for (payload, limit, expected, reason) in [
            (vec![], 64, vec![], ErrorBodyStopReason::Complete),
            (
                b"secret".to_vec(),
                0,
                vec![],
                ErrorBodyStopReason::ByteLimit,
            ),
            (
                b"secret".to_vec(),
                6,
                b"secret".to_vec(),
                ErrorBodyStopReason::ByteLimit,
            ),
            (
                vec![0xff, 0xfe],
                64,
                vec![0xff, 0xfe],
                ErrorBodyStopReason::Complete,
            ),
            (
                "😺".as_bytes().to_vec(),
                2,
                vec![0xf0, 0x9f],
                ErrorBodyStopReason::ByteLimit,
            ),
        ] {
            let (url, capture, task) = server(400, Some("application/octet-stream"), payload).await;
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .with_error_body_limits(ErrorBodyLimits {
                    max_bytes: limit,
                    read_timeout: Duration::from_secs(2),
                })
                .build()
                .unwrap();
            let error = agent.run(&input()).await.err().unwrap();
            let body = error.http_error_body().unwrap();
            assert_eq!(body.bytes(), expected);
            assert_eq!(body.text(), std::str::from_utf8(&expected));
            assert_eq!(body.stop_reason(), reason);
            assert_eq!(body.is_truncated(), reason != ErrorBodyStopReason::Complete);
            capture.await.unwrap();
            task.await.unwrap();
        }
        assert!(AgUiClientError::config("test").http_error_body().is_none());
    })
    .await
    .expect("fixture client or server join timed out");
}

#[tokio::test]
async fn error_body_capture_retains_prefix_on_timeout_and_read_failure() {
    tokio::time::timeout(TEST_TIMEOUT, async {
        for fail_read in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                http::read(&mut socket).await.unwrap();
                socket
                    .write_all(
                        b"HTTP/1.1 503 Test\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nsecret\r\n",
                    )
                    .await
                    .unwrap();
                if fail_read {
                    // A complete data chunk followed by a missing terminal chunk.
                    socket.shutdown().await.unwrap();
                } else {
                    let mut byte = [0];
                    let closed = socket.read(&mut byte).await;
                    assert!(matches!(closed, Ok(0) | Err(_)));
                }
            });
            let agent = HttpAgent::builder()
                .with_url_str(&url)
                .unwrap()
                .with_error_body_limits(ErrorBodyLimits {
                    max_bytes: 64,
                    read_timeout: Duration::from_millis(100),
                })
                .build()
                .unwrap();
            let error = agent.run(&input()).await.err().unwrap();
            let body = error.http_error_body().unwrap();
            assert_eq!(body.bytes(), b"secret");
            assert!(body.is_truncated());
            assert_eq!(
                body.stop_reason(),
                if fail_read {
                    ErrorBodyStopReason::ReadFailed
                } else {
                    ErrorBodyStopReason::ReadTimeout
                }
            );
            assert!(!format!("{error:?} {error}").contains("secret"));
            task.await.unwrap();
        }
    })
    .await
    .expect("fixture client or server join timed out");
}
