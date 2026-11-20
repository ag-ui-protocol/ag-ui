//! Multimodal tool results retain the 1.0 content part list across decoding and application.

#![cfg(all(feature = "client", feature = "sse"))]

use std::path::Path;

use ag_ui::client::apply::Applier;
use ag_ui::client::transport::decode_events;
use ag_ui::client::{normalize_all, verify_all};
use ag_ui::{Event, InputContent, InputContentSource, MediaInputContent, Message, ToolContent};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};

#[tokio::test]
async fn official_tool_result_parts_fixture_decodes_applies_and_round_trips() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    if !root.join(".git").exists() {
        return; // Published crates do not carry the monorepo corpus.
    }
    let file = root.join("spec/1.0/conformance/streams/tool-result-parts-mint-tool-message.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let body = fixture["stream"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| ag_ui::encode::sse::frame(&event.to_string()))
        .collect::<String>();
    let events: Vec<Event> =
        decode_events(stream::iter([Ok::<_, std::io::Error>(body.into_bytes())]))
            .map(Result::unwrap)
            .collect()
            .await;
    let events = normalize_all(events).unwrap();
    verify_all(&events).unwrap();

    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).unwrap();
    }
    let expected = &fixture["expect"]["messages"][1]["content"];
    let Message::Tool(tool) = applier.message(&"toolparts-t1".into()).unwrap() else {
        panic!("the result should mint a tool message");
    };
    assert_eq!(
        applier.text_of("toolparts-t1"),
        Some("Invoice INV-2291 attached.")
    );
    assert!(matches!(&tool.content, ToolContent::Parts(_)));
    assert_eq!(serde_json::to_value(&tool.content).unwrap(), *expected);
    assert_eq!(serde_json::to_value(tool).unwrap()["content"], *expected);
    let Event::ToolCallResult(result) = &events[4] else {
        panic!("the fifth event should be the result");
    };
    assert_eq!(serde_json::to_value(&result.content).unwrap(), *expected);
}

#[test]
fn file_handle_and_part_metadata_round_trip_without_flattening() {
    let content = ToolContent::Parts(vec![
        InputContent::text("The transcript is attached."),
        InputContent::Audio(MediaInputContent {
            id: Some("audio-1".into()),
            source: InputContentSource::File {
                value: "file-provider-123".into(),
                provider: Some("openai".into()),
                mime_type: Some("audio/wav".into()),
            },
            metadata: Some(json!({"durationSeconds": 5})),
        }),
    ]);
    let message = Message::tool("m", "c", content);
    let wire = serde_json::to_value(&message).unwrap();
    assert_eq!(wire["content"][1]["source"]["type"], "file");
    assert_eq!(wire["content"][1]["source"]["value"], "file-provider-123");
    assert_eq!(
        serde_json::from_value::<Message>(wire.clone()).unwrap(),
        message
    );
}
