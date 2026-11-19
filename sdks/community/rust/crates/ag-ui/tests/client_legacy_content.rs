//! A legacy `binary` content part leaves the client as the 1.0 media part it
//! stands for.
//!
//! AG-UI 1.0 retired `{type: "binary"}`, and a 1.0 agent strips what it does
//! not describe. The upstream streams `era-0-0-47-upgrades-binary-content` and
//! `era-current-peer-keeps-modern-content` hold a client to translating it on
//! the way out.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RemoteAgent, RunParams, Thread};
use ag_ui::{Event, Message};
use futures_util::StreamExt;
use serde_json::{Value, json};

fn history() -> Vec<Message> {
    serde_json::from_value(json!([
        {"id": "u1", "role": "user", "content": [
            {"type": "text", "text": "Describe these."},
            {"type": "binary", "mimeType": "image/png", "url": "https://example.com/a.png"},
            {"type": "binary", "mimeType": "audio/wav", "data": "UklGRg==", "filename": "a.wav"},
            {"type": "binary", "mimeType": "application/pdf", "data": "JVBERg==",
             "url": "https://example.com/a.pdf"},
            {"type": "binary", "mimeType": "video/mp4", "id": "upload-7"},
            // A legacy mirror of the modern part next to it is dropped ...
            {"type": "image", "source":
                {"type": "url", "value": "https://example.com/b.png", "mimeType": "image/png"}},
            {"type": "binary", "mimeType": "image/png", "url": "https://example.com/b.png"},
            // ... unless it carries a file name the modern part does not keep.
            {"type": "binary", "mimeType": "image/png", "url": "https://example.com/b.png",
             "filename": "b.png"}
        ]},
        {"id": "a1", "role": "assistant", "toolCalls": [
            {"id": "c1", "type": "function", "function": {"name": "scan", "arguments": "{}"}}
        ]},
        {"id": "t1", "role": "tool", "toolCallId": "c1", "content": [
            {"type": "binary", "mimeType": "text/csv", "url": "https://example.com/rows.csv"}
        ]}
    ]))
    .expect("the typed messages still read the legacy part")
}

fn id_only() -> Value {
    json!({"type": "binary", "mimeType": "video/mp4", "id": "upload-7"})
}

fn url(kind: &str, value: &str, mime: &str) -> Value {
    json!({"type": kind, "source": {"type": "url", "value": value, "mimeType": mime}})
}

/// `id_only` is what became of the part that carries only an `id`, which has
/// no 1.0 source to become: a request sends it as it is, and the boundary
/// drops it from an event.
fn assert_upgraded(sent: &[Message], id_only: Option<Value>) {
    let sent = serde_json::to_value(sent).unwrap();
    let mut expected = vec![
        json!({"type": "text", "text": "Describe these."}),
        url("image", "https://example.com/a.png", "image/png"),
        json!({"type": "audio",
            "source": {"type": "data", "value": "UklGRg==", "mimeType": "audio/wav"},
            "metadata": {"filename": "a.wav"}}),
        // Inline data wins over a URL.
        json!({"type": "document",
            "source": {"type": "data", "value": "JVBERg==", "mimeType": "application/pdf"}}),
    ];
    expected.extend(id_only);
    expected.extend([
        url("image", "https://example.com/b.png", "image/png"),
        json!({"type": "image",
            "source": {"type": "url", "value": "https://example.com/b.png", "mimeType": "image/png"},
            "metadata": {"filename": "b.png"}}),
    ]);
    assert_eq!(sent[0]["content"], Value::Array(expected));
    assert_eq!(
        sent[2]["content"],
        json!([url("document", "https://example.com/rows.csv", "text/csv")])
    );
}

fn success() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
    ]
}

#[tokio::test]
async fn a_thread_sends_the_media_part_and_keeps_its_own_copy_as_written() {
    let transport = ReplayTransport::new(success()).matching_requests();
    let mut thread = Thread::<_>::builder(transport.clone(), "t")
        .messages(history())
        .build()
        .unwrap();
    thread.run().unwrap().collect_report().await;

    assert_upgraded(&transport.last_request().unwrap().messages, Some(id_only()));
    assert_eq!(thread.messages(), history());
}

#[tokio::test]
async fn a_legacy_part_arriving_in_an_event_is_read_as_the_media_part() {
    // AG-UI 1.0, "Retired shapes": "A consumer SHOULD translate a retired
    // shape into its replacement rather than drop it", before enforcement.
    // The same list as a request's, in a snapshot, and one in a tool result.
    let result = Event::tool_call_result(
        "t2",
        "c1",
        vec![ag_ui::InputContent::Binary(ag_ui::BinaryInputContent {
            mime_type: "audio/wav".into(),
            url: Some("https://example.com/b.wav".into()),
            ..Default::default()
        })],
    );
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::messages_snapshot(history()),
        result,
        Event::run_finished_success("t", "r"),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    let report = thread.run().unwrap().collect_report().await;

    assert_eq!(report.end, ag_ui::client::RunEnd::Success { result: None });
    assert_upgraded(thread.messages(), None);
    let delivered = serde_json::to_value(thread.messages()).unwrap();
    assert_eq!(
        delivered[3]["content"],
        json!([url("audio", "https://example.com/b.wav", "audio/wav")])
    );
}

#[tokio::test]
async fn run_events_sends_the_media_part_too() {
    let transport = ReplayTransport::new(success());
    let agent = RemoteAgent::new(transport.clone());
    let events: Vec<_> = agent
        .run_events(RunParams::new("t", "r").messages(history()))
        .collect()
        .await;
    assert_eq!(events.len(), 2);
    assert_upgraded(&transport.last_request().unwrap().messages, Some(id_only()));
}

#[tokio::test]
async fn input_echo_is_upgraded_before_schema_enforcement() {
    let mut started = Event::run_started("t", "r");
    let Event::RunStarted(start) = &mut started else {
        unreachable!()
    };
    let mut input = ag_ui::RunAgentInput::new("t", "r");
    input.messages = history();
    start.input = Some(Box::new(input));
    let agent = RemoteAgent::new(ReplayTransport::new([started]));
    let events: Vec<_> = agent.run_events(RunParams::new("t", "r")).collect().await;
    let Event::RunStarted(start) = events[0].as_ref().unwrap() else {
        unreachable!()
    };
    assert_upgraded(&start.input.as_ref().unwrap().messages, None);
}
