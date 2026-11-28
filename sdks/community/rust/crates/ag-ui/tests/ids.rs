//! Identifiers are opaque strings, not UUIDs.
//!
//! LangGraph sends thread ids like `"thread-abc"` and run ids that are bare
//! integers. An SDK that parses these as UUIDs rejects valid traffic
//! (ag-ui-protocol/ag-ui#2195, #2196), so every shape below must survive a
//! round-trip byte-for-byte.

use ag_ui::*;
use serde_json::json;

/// Ids seen in the wild, plus the degenerate cases.
const AWKWARD_IDS: &[&str] = &[
    "thread-abc",
    "1",
    "",
    "550e8400-e29b-41d4-a716-446655440000",
    "run_01JQ8Z9WYX",
    "여러-언어",
    "id with spaces",
    "a/b?c=d#e",
    "  ",
];

macro_rules! assert_id_round_trips {
    ($ty:ty, $value:expr) => {{
        let id = <$ty>::new($value);
        assert_eq!(id.as_str(), $value);
        assert_eq!(id.to_string(), $value);

        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, serde_json::to_string($value).unwrap());

        let back: $ty = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
        assert_eq!(back.into_inner(), $value);
    }};
}

#[test]
fn non_uuid_identifiers_round_trip_losslessly() {
    for value in AWKWARD_IDS {
        assert_id_round_trips!(ThreadId, *value);
        assert_id_round_trips!(RunId, *value);
        assert_id_round_trips!(MessageId, *value);
        assert_id_round_trips!(ToolCallId, *value);
        assert_id_round_trips!(AgentId, *value);
        assert_id_round_trips!(StepName, *value);
    }
}

#[test]
fn identifiers_serialize_as_bare_strings() {
    assert_eq!(
        serde_json::to_value(ThreadId::new("thread-abc")).unwrap(),
        json!("thread-abc")
    );
    assert!(MessageId::new("").is_empty());
}

#[test]
fn events_keep_non_uuid_identifiers_intact() {
    let event = Event::run_started("thread-abc", "1");
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["threadId"], "thread-abc");
    assert_eq!(json["runId"], "1");
    assert_eq!(serde_json::from_value::<Event>(json).unwrap(), event);
}

#[test]
fn a_langgraph_shaped_payload_deserializes() {
    let input: RunAgentInput = serde_json::from_str(
        r#"{
            "threadId": "thread-abc",
            "runId": "1",
            "state": {},
            "messages": [],
            "tools": [],
            "context": [],
            "forwardedProps": {}
        }"#,
    )
    .expect("arbitrary string ids must parse");

    assert_eq!(input.thread_id, "thread-abc");
    assert_eq!(input.run_id, "1");
    assert!(!input.is_resume());
}

#[test]
fn identifiers_convert_from_every_string_flavour() {
    let owned: ThreadId = String::from("t").into();
    let borrowed: ThreadId = "t".into();
    let parsed: ThreadId = "t".parse().unwrap();
    let built = ThreadId::new("t");

    assert_eq!(owned, borrowed);
    assert_eq!(borrowed, parsed);
    assert_eq!(parsed, built);
    assert_eq!(built.as_ref(), "t");
    assert_eq!(built, "t");
    assert_eq!(String::from(built), "t");
}
