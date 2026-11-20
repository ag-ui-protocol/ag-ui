//! Optional JSON payloads must not be serialized as present nulls in 1.0.

#![cfg(all(feature = "client", feature = "sse"))]

use ag_ui::client::transport::decode_events;
use ag_ui::{
    Event, InputContent, InputContentSource, MediaInputContent, Message, ResumeEntry,
    RunAgentInput, RunErrorEvent, RunFinishedEvent, RunOutcome, SubagentFinishedEvent,
    TextInputContent, TokenUsage, Tool, ToolCallChunkEvent, ToolCallResultEvent,
    ToolCallStartEvent,
};
use futures_util::{StreamExt, stream};
use serde_json::Value;

fn contains_null(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Array(items) => items.iter().any(contains_null),
        Value::Object(members) => members.values().any(contains_null),
        _ => false,
    }
}

/// Every row of the upstream `DEPRECATIONS.md` optional-null registry, from the
/// producing side: a value left empty, or set to `null` where the Rust type
/// can hold one, is written as an omitted field and never as `null`.
#[test]
fn no_registered_optional_null_shape_is_ever_serialized() {
    let media = |make: fn(MediaInputContent) -> InputContent| {
        let mut part = MediaInputContent::new(InputContentSource::Url {
            value: "https://example.com/attachment".into(),
            mime_type: None,
        });
        part.metadata = Some(Value::Null);
        make(part)
    };
    let mut input = RunAgentInput::new("thread", "run");
    input.messages.push(Message::user(
        "m1",
        vec![
            media(InputContent::Image),
            media(InputContent::Audio),
            media(InputContent::Video),
            media(InputContent::Document),
        ],
    ));
    input.tools.push(Tool::new("lookup", "Lookup", Value::Null));
    input.resume = Some(vec![ResumeEntry::resolved("i1", Value::Null)]);
    assert!(input.forwarded_props.is_null());

    let mut raw = Event::text_message_end("m1");
    raw.base_mut().raw_event = Some(Value::Null);
    let mut finished = RunFinishedEvent::new("thread", "run")
        .with_outcome(RunOutcome::Success)
        .with_usage(vec![TokenUsage::default()]);
    finished.result = Some(Value::Null);
    let mut child = SubagentFinishedEvent::new("child");
    child.result = Some(Value::Null);

    for (rows, value) in [
        (
            "parentMessageId on TOOL_CALL_START",
            serde_json::to_value(Event::from(ToolCallStartEvent::new("c1", "search"))),
        ),
        (
            "parentMessageId on TOOL_CALL_CHUNK",
            serde_json::to_value(Event::from(ToolCallChunkEvent::new(
                Some("c1".into()),
                None,
                None,
            ))),
        ),
        (
            "rawEvent and subagentRunId on an event",
            serde_json::to_value(raw),
        ),
        (
            "result and outcome on RUN_FINISHED, pendingToolCallIds on its outcome, \
             provider, reasoningTokens, cachedInputTokens and cacheWriteInputTokens on \
             its usage entries",
            serde_json::to_value(Event::from(finished)),
        ),
        (
            "result on SUBAGENT_FINISHED",
            serde_json::to_value(Event::from(child)),
        ),
        (
            "parentRunId and input on RUN_STARTED",
            serde_json::to_value(Event::run_started("thread", "run")),
        ),
        (
            "role on TOOL_CALL_RESULT",
            serde_json::to_value(Event::from(ToolCallResultEvent::new("m1", "c1", "done"))),
        ),
        (
            "usage on RUN_ERROR",
            serde_json::to_value(Event::from(RunErrorEvent::new("boom"))),
        ),
        (
            "forwardedProps on RunAgentInput, parameters on a tool, payload on a resume \
             entry, metadata on image, audio, video and document content parts",
            serde_json::to_value(&input),
        ),
    ] {
        let value = value.unwrap();
        assert!(!contains_null(&value), "{rows}: {value}");
    }
}

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
