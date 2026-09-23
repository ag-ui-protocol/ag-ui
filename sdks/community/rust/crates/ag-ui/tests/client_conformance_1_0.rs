//! Normative cases replayed from the checked-in AG-UI 1.0 corpus.
#![cfg(all(feature = "client", feature = "sse"))]

use std::path::Path;

use ag_ui::client::apply::Applier;
use ag_ui::client::transport::decode_events;
use ag_ui::client::{normalize_all, verify_all};
use ag_ui::{Event, EventType};
use futures_util::{StreamExt, stream};
use serde_json::Value;

#[test]
fn embedded_client_schema_matches_the_frozen_protocol_schema() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    if !root.join(".git").exists() {
        return;
    }
    let official = std::fs::read_to_string(root.join("spec/1.0/schema.json")).unwrap();
    assert_eq!(include_str!("../src/client/schema-1.0.json"), official);
}

fn corpus_stream(name: &str) -> Option<Vec<Value>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../..");
    // Published crates do not carry the monorepo's protocol corpus. In this
    // checkout, absence is an error rather than silently skipping the gate.
    if !root.join(".git").exists() {
        return None;
    }
    let file = root.join(format!("spec/1.0/conformance/streams/{name}.json"));
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    Some(fixture["stream"].as_array().unwrap().clone())
}

async fn decode(name: &str) -> Option<Vec<ag_ui::client::Result<Event>>> {
    let stream = corpus_stream(name)?;
    let body = stream
        .iter()
        .map(|event| ag_ui::encode::sse::frame(&event.to_string()))
        .collect::<String>();
    Some(
        decode_events(stream::iter([Ok::<_, std::io::Error>(body.into_bytes())]))
            .collect()
            .await,
    )
}

#[tokio::test]
async fn corpus_unknown_event_survives_and_malformed_known_field_fails() {
    let Some(events) = decode("unknown-event-dropped").await else {
        return;
    };
    let types = events
        .into_iter()
        .map(|event| event.unwrap().event_type())
        .collect::<Vec<_>>();
    assert_eq!(types.len(), 6);
    assert_eq!(types.last(), Some(&EventType::RunFinished));

    let Some(events) = decode("malformed-known-field-fatal").await else {
        return;
    };
    assert_eq!(events.len(), 3);
    assert!(
        events[2]
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("/delta")
    );
}

#[tokio::test]
async fn corpus_chunk_order_and_expansion_reach_the_verifier() {
    let Some(events) = decode("first-chunk-missing-id-fatal").await else {
        return;
    };
    let error = normalize_all(events.into_iter().map(Result::unwrap)).unwrap_err();
    assert!(error.to_string().contains("no messageId"), "{error}");

    let Some(events) = decode("chunk-expansion-assembles").await else {
        return;
    };
    let expanded = normalize_all(events.into_iter().map(Result::unwrap)).unwrap();
    verify_all(&expanded).unwrap();
    let mut applier = Applier::new();
    for event in &expanded {
        applier.apply(event).unwrap();
    }
    assert_eq!(applier.text_of("chunk-expand-m1"), Some("Chunks expand."));
}

#[tokio::test]
async fn corpus_unknown_nested_content_is_removed_before_delivery() {
    let Some(events) = decode("unknown-part-in-message-list").await else {
        return;
    };
    let values = events
        .into_iter()
        .map(|event| serde_json::to_value(event.unwrap()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        values[1]["messages"][0]["content"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(values[1]["messages"][0]["content"][0]["text"], "before");
    assert_eq!(values[1]["messages"][0]["content"][1]["text"], "after");
}

#[tokio::test]
async fn corpus_unknown_outcome_and_patch_operation_are_stripped() {
    let Some(events) = decode("unknown-outcome-stripped").await else {
        return;
    };
    let finished = events.last().unwrap().as_ref().unwrap();
    let serialized = serde_json::to_value(finished).unwrap();
    assert!(serialized.get("outcome").is_none());

    let Some(events) = decode("state-delta-unknown-op-dropped").await else {
        return;
    };
    let events = events.into_iter().map(Result::unwrap).collect::<Vec<_>>();
    let delta = serde_json::to_value(&events[2]).unwrap();
    assert_eq!(delta["delta"].as_array().unwrap().len(), 1);
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).unwrap();
    }
    assert_eq!(applier.state()["count"], 5);
}

#[tokio::test]
async fn corpus_retired_thinking_is_translated_before_verification() {
    let Some(events) = decode("era-0-0-45-thinking-translated").await else {
        return;
    };
    let events = events.into_iter().map(Result::unwrap).collect::<Vec<_>>();
    assert!(
        !events
            .iter()
            .any(|event| event.event_type().as_str().starts_with("THINKING_"))
    );
    let expanded = normalize_all(events).unwrap();
    verify_all(&expanded).unwrap();
}
