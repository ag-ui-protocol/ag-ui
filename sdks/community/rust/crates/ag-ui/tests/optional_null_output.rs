//! Optional JSON payloads must not be serialized as present nulls in 1.0.

#![cfg(all(feature = "client", feature = "sse"))]

use ag_ui::client::transport::decode_events;
use ag_ui::{
    Event, InputContent, Message, RunAgentInput, RunFinishedEvent, SubagentFinishedEvent,
    TextInputContent, Tool,
};
use futures_util::{StreamExt, stream};
use serde_json::Value;

#[tokio::test]
async fn optional_null_payloads_leave_no_wire_field_and_decode_as_1_0() {
    let mut started = Event::run_started("thread", "run").with_raw_event(Value::Null);
    assert!(started.base().raw_event.is_none());
    // Public fields can also be assigned directly, bypassing the builder.
    started.base_mut().raw_event = Some(Value::Null);

    let mut finished = RunFinishedEvent::new("thread", "run").with_result(Value::Null);
    assert!(finished.result.is_none());
    finished.result = Some(Value::Null);

    let mut child = SubagentFinishedEvent::new("child").with_result(Value::Null);
    assert!(child.result.is_none());
    child.result = Some(Value::Null);

    for (event, absent_field) in [
        (started, "rawEvent"),
        (Event::from(finished), "result"),
        (Event::from(child), "result"),
    ] {
        let json = serde_json::to_value(&event).unwrap();
        assert!(json.get(absent_field).is_none(), "{json}");
        let frame = ag_ui::encode::sse::frame(&json.to_string());
        let decoded = decode_events(stream::iter([Ok::<_, std::io::Error>(frame.into_bytes())]))
            .collect::<Vec<_>>()
            .await;
        assert!(matches!(decoded.as_slice(), [Ok(_)]), "{decoded:?}");
    }
}

#[tokio::test]
async fn optional_null_tool_and_content_part_fields_are_omitted() {
    let mut input = RunAgentInput::new("thread", "run");
    input.tools.push(Tool::new("lookup", "Lookup", Value::Null));
    input.messages.push(Message::user(
        "user-message",
        vec![InputContent::Text(TextInputContent {
            text: "hello".into(),
            metadata: Some(Value::Null),
            ..Default::default()
        })],
    ));
    let mut started = Event::run_started("thread", "run");
    let Event::RunStarted(ref mut payload) = started else {
        unreachable!();
    };
    payload.input = Some(Box::new(input));

    let json = serde_json::to_value(&started).unwrap();
    assert!(json["input"]["tools"][0].get("parameters").is_none());
    assert!(
        json["input"]["messages"][0]["content"][0]
            .get("metadata")
            .is_none()
    );
    let frame = ag_ui::encode::sse::frame(&json.to_string());
    let decoded = decode_events(stream::iter([Ok::<_, std::io::Error>(frame.into_bytes())]))
        .collect::<Vec<_>>()
        .await;
    assert!(matches!(decoded.as_slice(), [Ok(_)]), "{decoded:?}");

    assert!(
        serde_json::from_value::<Tool>(serde_json::json!({
            "name": "lookup", "description": "Lookup", "parameters": null
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<TextInputContent>(serde_json::json!({
            "text": "hello", "metadata": null
        }))
        .is_err()
    );
}
