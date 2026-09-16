//! Every event type: wire tag, round-trip, and the optional-field rules.

#![allow(deprecated)]

use std::collections::BTreeSet;
use std::str::FromStr;

use ag_ui::*;
use serde_json::{Value, json};

/// The canonical `type` strings, straight from the upstream `EventType` enum in
/// `sdks/typescript/packages/core/src/events.ts`.
const CANONICAL_TAGS: &[&str] = &[
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "TEXT_MESSAGE_CHUNK",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_CHUNK",
    "TOOL_CALL_RESULT",
    "THINKING_START",
    "THINKING_END",
    "THINKING_TEXT_MESSAGE_START",
    "THINKING_TEXT_MESSAGE_CONTENT",
    "THINKING_TEXT_MESSAGE_END",
    "STATE_SNAPSHOT",
    "STATE_DELTA",
    "MESSAGES_SNAPSHOT",
    "ACTIVITY_SNAPSHOT",
    "ACTIVITY_DELTA",
    "RAW",
    "CUSTOM",
    "RUN_STARTED",
    "RUN_FINISHED",
    "RUN_ERROR",
    "STEP_STARTED",
    "STEP_FINISHED",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_MESSAGE_CHUNK",
    "REASONING_END",
    "REASONING_ENCRYPTED_VALUE",
    "SUBAGENT_STARTED",
    "SUBAGENT_FINISHED",
    "SUBAGENT_ERROR",
];

fn activity_content() -> JsonObject {
    json!({ "query": "rust sse", "results": 3 })
        .as_object()
        .expect("object literal")
        .clone()
}

/// One populated event per type, in the same order as [`CANONICAL_TAGS`].
fn sample_events() -> Vec<Event> {
    vec![
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Hello"),
        Event::text_message_end("msg-1"),
        Event::text_message_chunk(Some("msg-1".into()), Some("Hello".into())),
        Event::tool_call_start("call-1", "get_weather"),
        Event::tool_call_args("call-1", r#"{"city":"#),
        Event::tool_call_end("call-1"),
        Event::tool_call_chunk(
            Some("call-1".into()),
            Some("get_weather".into()),
            Some("{}".into()),
        ),
        Event::tool_call_result("msg-2", "call-1", "18C and raining"),
        Event::thinking_start(Some("Planning".into())),
        Event::thinking_end(),
        Event::thinking_text_message_start(),
        Event::thinking_text_message_content("first, check the weather"),
        Event::thinking_text_message_end(),
        Event::state_snapshot(json!({ "counter": 1 })),
        Event::state_delta(vec![PatchOperation::replace("/counter", json!(2))]),
        Event::messages_snapshot(vec![
            Message::user("msg-0", "hi"),
            Message::assistant("msg-1", "Hello"),
        ]),
        Event::activity_snapshot("msg-3", "web_search", activity_content()),
        Event::activity_delta(
            "msg-3",
            "web_search",
            vec![PatchOperation::add("/results", json!(4))],
        ),
        Event::raw(json!({ "provider": "openai", "chunk": 1 })),
        Event::custom("confetti", json!({ "count": 100 })),
        Event::run_started("thread-1", "run-1"),
        Event::run_finished_success("thread-1", "run-1"),
        Event::run_error("upstream refused the connection"),
        Event::step_started("plan"),
        Event::step_finished("plan"),
        Event::reasoning_start("msg-4"),
        Event::reasoning_message_start("msg-4"),
        Event::reasoning_message_content("msg-4", "weighing options"),
        Event::reasoning_message_end("msg-4"),
        Event::reasoning_message_chunk(Some("msg-4".into()), Some("weighing".into())),
        Event::reasoning_end("msg-4"),
        Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::Message,
            "msg-4",
            "b64-blob",
        ),
        Event::subagent_started("sub-1", "researcher"),
        Event::subagent_finished_success("sub-1"),
        Event::subagent_error("sub-1", "rate limited"),
    ]
}

#[test]
fn protocol_defines_thirty_six_event_types() {
    assert_eq!(EventType::ALL.len(), 36);
    assert_eq!(CANONICAL_TAGS.len(), 36);
}

#[test]
fn samples_cover_every_event_type() {
    let covered: BTreeSet<EventType> = sample_events().iter().map(Event::event_type).collect();
    assert_eq!(covered.len(), EventType::ALL.len());
    assert_eq!(sample_events().len(), CANONICAL_TAGS.len());
}

#[test]
fn event_type_strings_match_the_canonical_names() {
    for (event_type, expected) in EventType::ALL.iter().zip(CANONICAL_TAGS) {
        assert_eq!(event_type.as_str(), *expected);
        assert_eq!(event_type.to_string(), *expected);
        assert_eq!(EventType::from_str(expected).unwrap(), *event_type);
        assert_eq!(
            serde_json::to_value(event_type).unwrap(),
            Value::String((*expected).to_owned())
        );
    }
}

#[test]
fn serialized_tag_matches_the_canonical_name() {
    for (event, expected) in sample_events().iter().zip(CANONICAL_TAGS) {
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(
            json["type"],
            *expected,
            "wrong tag for {:?}",
            event.event_type()
        );
        assert_eq!(event.event_type().as_str(), *expected);
    }
}

#[test]
fn every_event_round_trips_through_json() {
    for event in sample_events() {
        let text = serde_json::to_string(&event).unwrap();
        let back: Event = serde_json::from_str(&text).unwrap();
        assert_eq!(back, event, "round-trip changed {text}");
        assert_eq!(serde_json::to_string(&back).unwrap(), text);
    }
}

#[test]
fn base_event_fields_round_trip_through_the_flattened_representation() {
    for event in sample_events() {
        let stamped = event
            .clone()
            .with_timestamp(1_700_000_000_000)
            .with_raw_event(json!({ "upstream": true }))
            .with_metadata(json!({ "traceId": "abc" }).as_object().unwrap().clone());

        let json = serde_json::to_value(&stamped).unwrap();
        assert_eq!(json["timestamp"], json!(1_700_000_000_000_i64));
        assert_eq!(json["rawEvent"], json!({ "upstream": true }));
        assert_eq!(json["metadata"], json!({ "traceId": "abc" }));

        let back: Event = serde_json::from_value(json).unwrap();
        assert_eq!(back, stamped);
        assert_eq!(back.base().timestamp, Some(1_700_000_000_000));

        // The base is absent from the untouched event, not null.
        let bare = serde_json::to_value(&event).unwrap();
        assert!(bare.get("timestamp").is_none());
        assert!(bare.get("rawEvent").is_none());
        assert!(bare.get("metadata").is_none());
        assert!(event.base().is_empty());
    }
}

#[test]
fn absent_optional_fields_are_omitted_rather_than_null() {
    for event in sample_events() {
        let json = serde_json::to_value(&event).unwrap();
        let object = json.as_object().expect("events serialize as objects");
        for (key, value) in object {
            assert!(
                !value.is_null(),
                "{} emitted a null for {key}; optional fields must be skipped",
                event.event_type()
            );
        }
    }
}

#[test]
fn deprecated_thinking_events_are_flagged_but_still_encode() {
    let deprecated: Vec<Event> = sample_events()
        .into_iter()
        .filter(Event::is_deprecated)
        .collect();

    assert_eq!(deprecated.len(), 5);
    for event in deprecated {
        let json = serde_json::to_value(&event).unwrap();
        assert!(
            json["type"].as_str().unwrap().starts_with("THINKING"),
            "unexpected deprecated event {json}"
        );
    }
}

#[test]
fn unknown_event_types_are_rejected() {
    assert!(matches!(
        EventType::from_str("NOT_AN_EVENT"),
        Err(Error::UnknownEventType(name)) if name == "NOT_AN_EVENT"
    ));
    assert!(serde_json::from_str::<Event>(r#"{"type":"NOT_AN_EVENT"}"#).is_err());
}

#[test]
fn text_message_start_defaults_the_role_to_assistant() {
    let event: Event = serde_json::from_str(r#"{"type":"TEXT_MESSAGE_START","messageId":"m"}"#)
        .expect("role is optional on the wire");

    let Event::TextMessageStart(payload) = event else {
        panic!("wrong variant");
    };
    assert_eq!(payload.role, TextMessageRole::Assistant);
    // Once parsed the role is explicit, matching what the TypeScript SDK emits.
    assert_eq!(
        serde_json::to_string(&Event::TextMessageStart(payload)).unwrap(),
        r#"{"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}"#
    );
}

#[test]
fn an_explicitly_null_role_reads_as_the_default_rather_than_failing() {
    // A producer that models an optional field as nullable writes the absent
    // case as `null`, not by omitting the key — the same case
    // `TOOL_CALL_START.parentMessageId` already documents. Rejecting it would
    // fail the first event of every message such a producer sends.
    let event: Event =
        serde_json::from_str(r#"{"type":"TEXT_MESSAGE_START","messageId":"m","role":null}"#)
            .expect("a null role means the producer did not set one");

    let Event::TextMessageStart(payload) = event else {
        panic!("wrong variant");
    };
    assert_eq!(payload.role, TextMessageRole::Assistant);

    // An unknown role is still rejected: that is a producer bug, not an absence.
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"TEXT_MESSAGE_START","messageId":"m","role":"critic"}"#
        )
        .is_err()
    );
}

#[test]
fn activity_snapshot_defaults_replace_to_true() {
    let event: Event = serde_json::from_str(
        r#"{"type":"ACTIVITY_SNAPSHOT","messageId":"m","activityType":"search","content":{}}"#,
    )
    .expect("replace is optional on the wire");

    let Event::ActivitySnapshot(payload) = event else {
        panic!("wrong variant");
    };
    assert!(payload.replace);
}

#[test]
fn null_parent_message_id_is_read_as_absent() {
    // The .NET adapter serializes absent optionals as JSON null; a run must not
    // die on its first tool call because of it.
    let event: Event = serde_json::from_str(
        r#"{"type":"TOOL_CALL_START","toolCallId":"c","toolCallName":"t","parentMessageId":null}"#,
    )
    .expect("null must parse as absent");

    let Event::ToolCallStart(payload) = &event else {
        panic!("wrong variant");
    };
    assert_eq!(payload.parent_message_id, None);
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"TOOL_CALL_START","toolCallId":"c","toolCallName":"t"}"#
    );
}

#[test]
fn null_run_outcome_is_read_as_absent() {
    // Python producers using `model_dump()` without `exclude_none` emit this.
    let event: Event = serde_json::from_str(
        r#"{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":null}"#,
    )
    .expect("null must parse as absent");

    let Event::RunFinished(payload) = &event else {
        panic!("wrong variant");
    };
    assert_eq!(payload.outcome, None);
}

#[test]
fn run_finished_carries_an_interrupt_outcome() {
    let interrupt = Interrupt {
        message: Some("Send the email?".into()),
        tool_call_id: Some(ToolCallId::new("call-1")),
        ..Interrupt::new("int-1", "tool_approval")
    };
    let event = Event::run_finished_interrupt("thread-1", "run-1", vec![interrupt]);

    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["outcome"]["type"], "interrupt");
    assert_eq!(json["outcome"]["interrupts"][0]["id"], "int-1");
    assert_eq!(json["outcome"]["interrupts"][0]["reason"], "tool_approval");

    let back: Event = serde_json::from_value(json).unwrap();
    assert_eq!(back, event);

    let Event::RunFinished(payload) = back else {
        panic!("wrong variant");
    };
    let outcome = payload.outcome.unwrap();
    assert!(outcome.is_interrupt());
    assert_eq!(outcome.interrupts().len(), 1);
    outcome.validate().unwrap();
}

#[test]
fn an_empty_interrupt_list_parses_but_fails_validation() {
    // Deserializing stays permissive so one bad producer cannot kill a stream;
    // the rule is enforced where a caller can report it.
    let outcome: RunOutcome =
        serde_json::from_str(r#"{"type":"interrupt","interrupts":[]}"#).unwrap();
    assert!(matches!(outcome.validate(), Err(Error::Protocol(_))));
    assert!(RunOutcome::Success.validate().is_ok());
}

#[test]
fn run_started_can_carry_the_whole_input() {
    let input = RunAgentInput {
        state: json!({ "counter": 0 }),
        messages: vec![Message::user("msg-0", "hi")],
        tools: vec![Tool::new(
            "get_weather",
            "Look up the weather",
            json!({ "type": "object" }),
        )],
        context: vec![Context::new("page", "/dashboard")],
        forwarded_props: json!({ "locale": "ko-KR" }),
        resume: Some(vec![ResumeEntry::resolved("int-1", json!({ "ok": true }))]),
        ..RunAgentInput::new("thread-1", "run-1")
    };

    let event = Event::RunStarted(RunStartedEvent {
        input: Some(Box::new(input.clone())),
        ..RunStartedEvent::new("thread-1", "run-1")
    });

    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["input"]["forwardedProps"]["locale"], "ko-KR");
    assert_eq!(json["input"]["resume"][0]["status"], "resolved");

    let back: Event = serde_json::from_value(json).unwrap();
    assert_eq!(back, event);
    assert!(input.is_resume());
}

#[test]
fn run_finished_carries_token_usage() {
    let event = Event::RunFinished(RunFinishedEvent::new("thread-1", "run-1").with_usage(vec![
        TokenUsage {
            provider: Some("anthropic".into()),
            model: Some("claude-opus-5".into()),
            input_tokens: Some(1200),
            output_tokens: Some(340),
            ..Default::default()
        },
    ]));

    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(json["usage"][0]["inputTokens"], 1200);
    // Counts nobody reported stay absent rather than becoming zero.
    assert!(json["usage"][0].get("totalTokens").is_none());
    assert_eq!(serde_json::from_value::<Event>(json).unwrap(), event);
}

#[test]
fn events_convert_from_their_payloads() {
    let event: Event = TextMessageEndEvent::new("msg-1").into();
    assert_eq!(event, Event::text_message_end("msg-1"));
    assert_eq!(event.event_type(), EventType::TextMessageEnd);
}

#[test]
fn unknown_fields_are_tolerated() {
    // The upstream base schema is `.passthrough()`, so producers do add keys.
    // An unknown one must not fail the parse — it is dropped, not fatal.
    let event: Event = serde_json::from_str(
        r#"{"type":"TEXT_MESSAGE_END","messageId":"m","sequenceNumber":7,"vendor":{"a":1}}"#,
    )
    .expect("extra keys must not break the parse");

    assert_eq!(event, Event::text_message_end("m"));
}

#[test]
fn a_tool_result_may_declare_its_role() {
    let event: Event = serde_json::from_str(
        r#"{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":"ok","role":"tool"}"#,
    )
    .unwrap();

    let Event::ToolCallResult(payload) = &event else {
        panic!("wrong variant");
    };
    assert_eq!(payload.role, Some(ToolResultRole::Tool));
    assert_eq!(serde_json::to_value(&event).unwrap()["role"], json!("tool"));
}
