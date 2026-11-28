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
            {"type": "binary", "mimeType": "AUDIO/WAV", "data": "UklGRg==", "filename": "a.wav"},
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

fn url(kind: &str, value: &str, mime: &str) -> Value {
    json!({"type": kind, "source": {"type": "url", "value": value, "mimeType": mime}})
}

fn assert_upgraded(sent: &[Message]) {
    let sent = serde_json::to_value(sent).unwrap();
    let mut expected = vec![
        json!({"type": "text", "text": "Describe these."}),
        url("image", "https://example.com/a.png", "image/png"),
        json!({"type": "audio",
            "source": {"type": "data", "value": "UklGRg==", "mimeType": "AUDIO/WAV"},
            "metadata": {"filename": "a.wav"}}),
        // Inline data wins over a URL.
        json!({"type": "document",
            "source": {"type": "data", "value": "JVBERg==", "mimeType": "application/pdf"}}),
    ];
    expected.extend([
        json!({"type": "image", "source": {"type": "url", "value": "https://example.com/b.png", "mimeType": "image/png"}}),
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
    let report = thread.run().unwrap().collect_report().await;
    assert!(
        report
            .diagnostics
            .iter()
            .any(|warning| warning.message.contains("binary")
                && warning.message.contains("/messages/0/content/4"))
    );

    assert_upgraded(&transport.last_request().unwrap().messages);
    assert_eq!(thread.messages(), history());
}

#[tokio::test]
async fn a_legacy_part_arriving_in_an_event_is_read_as_the_media_part_with_a_warning() {
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
    assert_upgraded(thread.messages());
    let delivered = serde_json::to_value(thread.messages()).unwrap();
    assert_eq!(
        delivered[3]["content"],
        json!([url("audio", "https://example.com/b.wav", "audio/wav")])
    );

    let warnings: Vec<&str> = report
        .diagnostics
        .iter()
        .inspect(|diagnostic| assert_eq!(diagnostic.kind, "warning", "{diagnostic:?}"))
        .map(|diagnostic| diagnostic.message.as_str())
        .collect();
    assert_eq!(
        warnings,
        [
            "translated retired binary content part at /messages/0/content/1 to image",
            "translated retired binary content part at /messages/0/content/2 to audio",
            "translated retired binary content part at /messages/0/content/3 to document",
            "dropped retired binary content part at /messages/0/content/6: the image part \
             beside it carries the same payload",
            "translated retired binary content part at /messages/0/content/7 to image",
            "translated retired binary content part at /messages/2/content/0 to document",
            // An id alone has no 1.0 form, so enforcement drops it as before.
            r#"unrecognised union member "binary" at /messages/0/content/4"#,
            "translated retired binary content part at /content/0 to audio",
        ]
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
    assert_upgraded(&transport.last_request().unwrap().messages);
}

#[tokio::test]
async fn explicit_conflicting_mime_types_preserve_both_url_parts() {
    let transport = ReplayTransport::new(success());
    let agent = RemoteAgent::new(transport.clone());
    let user: Message = serde_json::from_value(json!({
        "role":"user", "id":"u", "content":[
            {"type":"image","source":{"type":"url","value":"a","mimeType":"image/jpeg"}},
            {"type":"binary","url":"a","mimeType":"IMAGE/PNG"}
        ]
    }))
    .unwrap();
    agent
        .run_events(RunParams::new("t", "r").message(user))
        .collect::<Vec<_>>()
        .await;
    let sent = serde_json::to_value(transport.last_request().unwrap()).unwrap();
    assert_eq!(
        sent["messages"][0]["content"],
        json!([
            url("image", "a", "image/jpeg"),
            url("image", "a", "IMAGE/PNG")
        ])
    );
}

#[tokio::test]
async fn a_modern_url_without_mime_does_not_shadow_a_typed_legacy_url() {
    let transport = ReplayTransport::new(success());
    let agent = RemoteAgent::new(transport.clone());
    let modern = json!({"type":"image","source":{"type":"url","value":"same"}});
    let user: Message = serde_json::from_value(json!({
        "role":"user","id":"u","content":[
            modern, {"type":"binary","url":"same","mimeType":"image/webp"}
        ]
    }))
    .unwrap();
    agent
        .run_events(RunParams::new("t", "r").message(user))
        .collect::<Vec<_>>()
        .await;
    let request = serde_json::to_value(transport.last_request().unwrap()).unwrap();
    assert_eq!(
        request["messages"][0]["content"],
        json!([modern, url("image", "same", "image/webp")])
    );
}

#[tokio::test]
async fn inline_mirrors_match_mime_case_without_overwriting_modern_metadata() {
    let transport = ReplayTransport::new(success());
    let agent = RemoteAgent::new(transport.clone());
    let modern = json!({"type":"image","source":{"type":"data","value":"AQ==","mimeType":"image/png"},"metadata":{"caption":"kept"}});
    let user: Message = serde_json::from_value(json!({
        "role":"user","id":"u","content":[modern,{"type":"binary","data":"AQ==","mimeType":"IMAGE/PNG"}]
    })).unwrap();
    agent
        .run_events(RunParams::new("t", "r").message(user))
        .collect::<Vec<_>>()
        .await;
    let request = serde_json::to_value(transport.last_request().unwrap()).unwrap();
    assert_eq!(request["messages"][0]["content"], json!([modern]));
}
