#![cfg(feature = "axum")]

use ag_ui::Event;
use ag_ui::axum::{SseFrame, SseResponse};
use axum::body::to_bytes;
use futures_util::{Stream, StreamExt, stream};
use serde::Serialize;
use serde_json::json;
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::task::{Context, Poll};

async fn body(response: axum::response::Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

// Inspect the bytes already sent as well as the HTTP body error. Collecting
// only with `to_bytes` would discard a false RUN_ERROR before the failure.
async fn failed_body(response: axum::response::Response) -> (String, String) {
    let mut stream = response.into_body().into_data_stream();
    let mut received = Vec::new();
    while let Some(frame) = stream.next().await {
        match frame {
            Ok(bytes) => received.extend_from_slice(&bytes),
            Err(error) => {
                assert!(
                    stream.next().await.is_none(),
                    "body must stop after failure"
                );
                return (String::from_utf8(received).unwrap(), error.to_string());
            }
        }
    }
    panic!("expected transport body failure");
}

#[tokio::test]
async fn frames_send_standard_metadata_and_safe_comments_with_sdk_headers() {
    let mut event = Event::run_started("thread", "run");
    event.base_mut().metadata = Some(json!({"host":{"proof":true}}).as_object().unwrap().clone());
    let response = SseResponse::negotiate(None)
        .unwrap()
        .stream_frames(stream::iter([
            Ok::<_, ag_ui::server::Error>(SseFrame::Event(event)),
            Ok::<_, ag_ui::server::Error>(SseFrame::Comment(
                "replay\r\ndata: injected\r\nboundary".into(),
            )),
        ]));
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(
        response.headers()["cache-control"],
        "no-cache, no-store, no-transform"
    );
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    assert_eq!(response.headers()["vary"], "accept");
    let actual = body(response).await;
    let first = actual
        .lines()
        .next()
        .unwrap()
        .strip_prefix("data: ")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(first).unwrap();
    assert_eq!(payload["metadata"]["host"]["proof"], true);
    assert!(payload.get("host").is_none());
    assert!(actual.ends_with(": replay\n: data: injected\n: boundary\n\n"));
    assert_eq!(actual.matches("\ndata:").count(), 0);
}

#[tokio::test]
async fn native_and_framed_event_paths_produce_identical_bytes() {
    let event = Event::text_message_content("m", "one\ntwo\rthree");
    let native = SseResponse::negotiate(None)
        .unwrap()
        .stream(stream::iter([Ok(event.clone())]));
    let framed = SseResponse::negotiate(None)
        .unwrap()
        .stream_frames(stream::iter([Ok::<_, ag_ui::server::Error>(
            SseFrame::Event(event),
        )]));
    assert_eq!(body(native).await, body(framed).await);
}

#[tokio::test]
async fn explicit_host_compatibility_value_preserves_legacy_wire_shape() {
    // Supplying arbitrary Serialize is a compatibility facility, not a claim
    // that undeclared fields are part of the current standard event schema.
    let stored = json!({"type":"ACTIVITY_SNAPSHOT","messageId":"m","activityType":"surface","content":{"legacy":null},"legacyHostProof":false});
    let response = SseResponse::negotiate(None)
        .unwrap()
        .stream_frames(stream::iter([Ok::<_, ag_ui::server::Error>(
            SseFrame::Event(stored.clone()),
        )]));
    let actual = body(response).await;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(actual.trim().strip_prefix("data: ").unwrap())
            .unwrap(),
        stored
    );
}

struct Bad;
impl Serialize for Bad {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("secret-provider-payload"))
    }
}

struct DropProbe<S> {
    inner: S,
    dropped: Arc<AtomicUsize>,
}
impl<S> Drop for DropProbe<S> {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
    }
}
impl<S: Stream + Unpin> Stream for DropProbe<S> {
    type Item = S::Item;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

#[tokio::test]
async fn serialization_failure_does_not_invent_a_run_error_or_poll_again() {
    let polled = Arc::new(AtomicUsize::new(0));
    let counter = polled.clone();
    let dropped = Arc::new(AtomicUsize::new(0));
    let source = DropProbe {
        inner: stream::iter([
            Ok::<_, ag_ui::server::Error>(SseFrame::Event(Bad)),
            Ok::<_, ag_ui::server::Error>(SseFrame::Comment("must not be sent".into())),
        ])
        .inspect(move |_| {
            counter.fetch_add(1, Ordering::Relaxed);
        }),
        dropped: dropped.clone(),
    };
    let response = SseResponse::negotiate(None).unwrap().stream_frames(source);
    let (actual, error) = failed_body(response).await;
    assert!(actual.is_empty(), "no fabricated protocol event: {actual}");
    assert!(!error.contains("secret-provider-payload"));
    assert_eq!(polled.load(Ordering::Relaxed), 1);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn source_failure_ends_the_body_without_a_protocol_error() {
    let polled = Arc::new(AtomicUsize::new(0));
    let counter = polled.clone();
    let dropped = Arc::new(AtomicUsize::new(0));
    let source = DropProbe {
        inner: stream::iter([
            Ok::<_, ag_ui::server::Error>(SseFrame::Event(Event::run_started("thread", "run"))),
            Err(ag_ui::server::Error::agent("source unavailable")),
            Ok::<_, ag_ui::server::Error>(SseFrame::Event(Event::run_finished("thread", "run"))),
        ])
        .inspect(move |_| {
            counter.fetch_add(1, Ordering::Relaxed);
        }),
        dropped: dropped.clone(),
    };
    let response = SseResponse::negotiate(None).unwrap().stream_frames(source);
    let (actual, _) = failed_body(response).await;
    assert!(actual.contains("RUN_STARTED"));
    assert!(!actual.contains("RUN_ERROR"));
    assert!(!actual.contains("RUN_FINISHED"));
    assert_eq!(polled.load(Ordering::Relaxed), 2);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn dropping_external_subscription_drops_its_source() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let response = SseResponse::negotiate(None)
        .unwrap()
        .stream_frames(DropProbe {
            inner: stream::pending::<ag_ui::server::Result<SseFrame<Event>>>(),
            dropped: dropped.clone(),
        });
    drop(response);
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
}

#[test]
fn comment_newlines_cannot_inject_data_or_event_fields() {
    assert_eq!(
        ag_ui::encode::sse::comment("a\rb\nc\r\nd"),
        ": a\n: b\n: c\n: d\n\n"
    );
    assert_eq!(
        ag_ui::encode::sse::comment("\ndata: injected\n\n"),
        ": \n: data: injected\n: \n: \n\n"
    );
}

#[tokio::test]
async fn explicitly_attached_cancellation_trips_when_framed_body_is_dropped() {
    let token = ag_ui::server::CancellationToken::new();
    let response = SseResponse::negotiate(None)
        .unwrap()
        .cancellation(token.clone())
        .stream_frames(stream::pending::<ag_ui::server::Result<SseFrame<Event>>>());
    drop(response);
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn serialization_failure_cancels_explicitly_owned_request_work() {
    let token = ag_ui::server::CancellationToken::new();
    let response = SseResponse::negotiate(None)
        .unwrap()
        .cancellation(token.clone())
        .stream_frames(stream::iter([Ok::<_, ag_ui::server::Error>(
            SseFrame::Event(Bad),
        )]));
    let (actual, _) = failed_body(response).await;
    assert!(!actual.contains("RUN_ERROR"));
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn source_failure_cancels_explicitly_owned_request_work() {
    let token = ag_ui::server::CancellationToken::new();
    let response = SseResponse::negotiate(None)
        .unwrap()
        .cancellation(token.clone())
        .stream_frames(stream::iter([Err::<SseFrame<Event>, _>(
            ag_ui::server::Error::agent("source unavailable"),
        )]));
    let (actual, _) = failed_body(response).await;
    assert!(!actual.contains("RUN_ERROR"));
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn clean_framed_eof_does_not_cancel_completed_request_work() {
    let token = ag_ui::server::CancellationToken::new();
    let response = SseResponse::negotiate(None)
        .unwrap()
        .cancellation(token.clone())
        .stream_frames(stream::iter([Ok::<_, ag_ui::server::Error>(
            SseFrame::Event(Event::run_finished("thread", "run")),
        )]));
    let actual = body(response).await;
    assert!(actual.contains("RUN_FINISHED"));
    assert!(!token.is_cancelled());
}

#[tokio::test]
async fn producer_supplied_run_failure_is_transmitted_without_reinterpretation() {
    let event = Event::from(ag_ui::RunErrorEvent::new("execution failed").with_code("EXECUTION"));
    let response = SseResponse::negotiate(None)
        .unwrap()
        .stream_frames(stream::iter([Ok::<_, ag_ui::server::Error>(
            SseFrame::Event(event),
        )]));
    let actual = body(response).await;
    assert_eq!(actual.matches("RUN_ERROR").count(), 1);
    assert!(actual.contains("EXECUTION"));
}

#[tokio::test]
async fn native_run_owned_stream_preserves_run_failure_mapping() {
    let response = SseResponse::negotiate(None)
        .unwrap()
        .stream(stream::iter([Err(ag_ui::server::Error::agent(
            "run failed",
        ))]));
    let actual = body(response).await;
    assert_eq!(actual.matches("RUN_ERROR").count(), 1);
}

#[tokio::test]
async fn axum_response_matches_standalone_encoder_without_double_framing() {
    for text in [
        "",
        "one",
        "one\n",
        "a\rb\nc\r\nd",
        "\ndata: injected\n\n",
        "Unicode: \u{1f680}",
    ] {
        let frames = [
            SseFrame::Event(Event::text_message_content("m", text)),
            SseFrame::Comment(text.to_owned()),
        ];
        let formatter = ag_ui::SseFormatter::new();
        let expected: String = frames
            .iter()
            .map(|frame| formatter.encode_frame(frame).unwrap())
            .collect();
        let response = SseResponse::negotiate(None)
            .unwrap()
            .stream_frames(stream::iter(frames.map(Ok::<_, std::convert::Infallible>)));
        assert_eq!(body(response).await, expected);
    }
}

#[tokio::test]
async fn external_source_can_use_io_errors_without_the_sdk_hosting_error_type() {
    let source = stream::iter([
        Ok(SseFrame::Event(Event::run_started("thread", "run"))),
        Err(std::io::Error::other("private source details")),
        Ok(SseFrame::Event(Event::run_finished("thread", "run"))),
    ]);
    let (prefix, error) =
        failed_body(SseResponse::negotiate(None).unwrap().stream_frames(source)).await;
    assert!(prefix.contains("RUN_STARTED"));
    assert!(!prefix.contains("RUN_ERROR"));
    assert!(!prefix.contains("RUN_FINISHED"));
    assert!(!error.contains("private source details"));
}

#[test]
fn keep_alive_response_can_be_built_outside_a_runtime_and_cancelled_before_poll() {
    let token = ag_ui::server::CancellationToken::new();
    let response = SseResponse::negotiate(None)
        .unwrap()
        .keep_alive(std::time::Duration::from_millis(5))
        .cancellation(token.clone())
        .stream_frames(stream::pending::<Result<SseFrame<Event>, std::io::Error>>());
    drop(response);
    assert!(token.is_cancelled());
}

#[test]
fn keep_alive_starts_when_the_body_is_polled_inside_a_runtime() {
    let token = ag_ui::server::CancellationToken::new();
    let response = SseResponse::negotiate(None)
        .unwrap()
        .keep_alive(std::time::Duration::from_millis(5))
        .cancellation(token.clone())
        .stream_frames(stream::pending::<Result<SseFrame<Event>, std::io::Error>>());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut frames = response.into_body().into_data_stream();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), frames.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(frame.as_ref(), b":\n\n");
        drop(frames);
    });
    assert!(token.is_cancelled());
}

#[tokio::test]
async fn native_source_error_cancels_owned_work_and_drops_source_before_terminal() {
    let token = ag_ui::server::CancellationToken::new();
    let dropped = Arc::new(AtomicUsize::new(0));
    let polled = Arc::new(AtomicUsize::new(0));
    let counter = polled.clone();
    let source = DropProbe {
        inner: stream::iter([
            Err(ag_ui::server::Error::agent("run failed")),
            Ok(Event::run_finished("thread", "run")),
        ])
        .inspect(move |_| {
            counter.fetch_add(1, Ordering::Relaxed);
        }),
        dropped: dropped.clone(),
    };
    let response = SseResponse::negotiate(None)
        .unwrap()
        .cancellation(token.clone())
        .stream(source);
    let mut frames = response.into_body().into_data_stream();
    let frame = frames.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&frame).unwrap().contains("RUN_ERROR"));
    assert!(token.is_cancelled());
    assert_eq!(dropped.load(Ordering::Relaxed), 1);
    assert_eq!(polled.load(Ordering::Relaxed), 1);
    assert!(frames.next().await.is_none());
}
