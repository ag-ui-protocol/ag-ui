use ag_ui_core::{event::*, types::*};
use ag_ui_encoder::*;
use serde_json::{Value, json};

fn event(value: Value) -> Event {
    serde_json::from_value(value).unwrap()
}
fn base() -> BaseEvent {
    BaseEvent::default()
}
fn payload(bytes: &[u8]) -> Value {
    assert!(bytes.starts_with(b"data: "));
    assert!(bytes.ends_with(b"\n\n"));
    let value: Value = serde_json::from_slice(&bytes[6..bytes.len() - 2]).unwrap();
    static SCHEMA: std::sync::OnceLock<jsonschema::Validator> = std::sync::OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../../spec/1.0/schema.json");
        let schema: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .build(&schema)
            .unwrap()
    });
    assert!(
        schema.is_valid(&value),
        "{:?}",
        schema.iter_errors(&value).collect::<Vec<_>>()
    );
    value
}
#[test]
fn exact_utf8_lf_only_framing_escapes_payload_newlines() {
    let bytes = encode(&event(
        json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"☃\nα\r\n"}),
    ))
    .unwrap();
    assert_eq!(bytes,b"data: {\"delta\":\"\xe2\x98\x83\\n\xce\xb1\\r\\n\",\"messageId\":\"m\",\"type\":\"TEXT_MESSAGE_CONTENT\"}\n\n");
    assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]));
    assert_eq!(CONTENT_TYPE, "text/event-stream; charset=utf-8");
}
#[test]
fn comment_lines_cannot_inject_sse_fields() {
    assert_eq!(keepalive("ping").unwrap(), b": ping\n\n");
    assert_eq!(keepalive("").unwrap(), b": \n\n");
    assert_eq!(
        keepalive("x\rdata: evil\r\nid: injected\nevent: nope").unwrap(),
        b": x\n: data: evil\n: id: injected\n: event: nope\n\n"
    );
}
#[test]
fn event_and_comment_limits_include_framing_and_have_exact_edges() {
    let e = event(json!({"type":"STATE_SNAPSHOT","snapshot":"α"}));
    let bytes = encode(&e).unwrap();
    let comment = keepalive("α").unwrap();
    for difference in [-1_i32, 0, 1] {
        let event_limit = (bytes.len() as i32 + difference) as usize;
        let comment_limit = (comment.len() as i32 + difference) as usize;
        let encoder = Encoder::new(Limits {
            max_event_bytes: event_limit,
            max_comment_bytes: comment_limit,
        });
        assert_eq!(encoder.encode(&e).is_ok(), difference >= 0);
        assert_eq!(encoder.keepalive("α").is_ok(), difference >= 0);
    }
    assert!(matches!(
        Encoder::new(Limits {
            max_event_bytes: 0,
            max_comment_bytes: 0
        })
        .encode(&e),
        Err(EncodeError::SizeLimit { kind: "event", .. })
    ));
    assert_eq!(Encoder::default().limits(), Limits::default());
}
#[test]
fn default_limits_are_finite_and_enforced_at_exact_edges() {
    let empty = event(json!({"type":"CUSTOM","name":"large","value":""}));
    let overhead = encode(&empty).unwrap().len();
    let fits = event(
        json!({"type":"CUSTOM","name":"large","value":"x".repeat(DEFAULT_MAX_EVENT_BYTES-overhead)}),
    );
    assert_eq!(encode(&fits).unwrap().len(), DEFAULT_MAX_EVENT_BYTES);
    let too_large = event(
        json!({"type":"CUSTOM","name":"large","value":"x".repeat(DEFAULT_MAX_EVENT_BYTES-overhead+1)}),
    );
    assert!(matches!(
        encode(&too_large),
        Err(EncodeError::SizeLimit { .. })
    ));
    assert_eq!(
        keepalive(&"x".repeat(DEFAULT_MAX_COMMENT_BYTES - 4))
            .unwrap()
            .len(),
        DEFAULT_MAX_COMMENT_BYTES
    );
    assert!(keepalive(&"x".repeat(DEFAULT_MAX_COMMENT_BYTES - 3)).is_err());
}
#[test]
fn stateless_encoding_preserves_omission_live_helper_declares_own_version() {
    for declaration in [None, Some("9.3"), Some("uninterpretable")] {
        let mut wire = json!({"type":"RUN_STARTED","threadId":"t","runId":"r"});
        if let Some(value) = declaration {
            wire["protocolVersion"] = json!(value);
        }
        let e = event(wire.clone());
        assert_eq!(payload(&encode(&e).unwrap()), wire);
        wire["protocolVersion"] = json!("1.0");
        assert_eq!(payload(&encode_live(&e).unwrap()), wire);
    }
}
#[test]
fn directly_constructed_optional_nulls_are_omitted_required_nulls_survive() {
    let finished: Event = Event::RunFinished({
        let mut value = RunFinishedEvent::new("t", "r").with_base({
            let mut value = base();
            value.raw_event = Some(Value::Null);
            value
        });
        value.result = Some(Value::Null);
        value
    });
    assert_eq!(
        payload(&encode(&finished).unwrap()),
        json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"})
    );
    let snapshot: Event =
        Event::StateSnapshot(StateSnapshotEvent::new(Value::Null).with_base(base()));
    assert_eq!(
        payload(&encode(&snapshot).unwrap())["snapshot"],
        Value::Null
    );
    let messages: Event = Event::MessagesSnapshot(
        MessagesSnapshotEvent::new(vec![Message::User {
            id: "u".into(),
            content: MessageContent::Parts(vec![
                ContentPart::Text {
                    text: "".into(),
                    id: None,
                    metadata: Some(Value::Null),
                },
                ContentPart::Image {
                    source: PartSource::Data {
                        value: "aGVsbG8=".into(),
                        mime_type: "image/png".into(),
                    },
                    id: None,
                    metadata: Some(json!({"nested":null})),
                },
            ]),
            name: None,
            metadata: Some(serde_json::Map::from_iter([("nested".into(), Value::Null)])),
            encrypted_value: Some("opaque".into()),
            subagent_run_id: None,
        }])
        .with_base(base()),
    );
    let out = payload(&encode(&messages).unwrap());
    assert!(out["messages"][0]["content"][0].get("metadata").is_none());
    assert_eq!(
        out["messages"][0]["content"][1]["metadata"],
        json!({"nested":null})
    );
    assert_eq!(out["messages"][0]["encryptedValue"], "opaque");
}
#[test]
fn constructed_illegal_values_are_rejected_before_any_bytes_are_returned() {
    let mut start = TextMessageStartEvent::new("m");
    start.role = Some(Role::Tool);
    assert!(encode(&Event::<Value>::TextMessageStart(start)).is_err());
    let mut start = TextMessageStartEvent::new("m");
    start.base.timestamp = Some(9_007_199_254_740_992);
    assert!(encode(&Event::<Value>::TextMessageStart(start)).is_err());
    let mut raw = event(json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}));
    if let Event::RunStarted(e) = &mut raw {
        e.base.subagent_run_id = Some("not-allowed".into());
    }
    assert!(encode(&raw).is_err());
    let deprecated: Event = Event::ThinkingEnd(ThinkingEndEvent::default().with_base(base()));
    assert!(encode(&deprecated).is_err());
    let mut e = event(json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"n"}));
    if let Event::SubagentStarted(e) = &mut e {
        e.base.subagent_run_id = Some("duplicate".into());
    }
    assert!(encode(&e).is_err());
    let mut e = event(json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}));
    if let Event::RunFinished(e) = &mut e {
        e.outcome = Some(RunFinishedOutcome::Interrupt { interrupts: vec![] });
    }
    assert!(encode(&e).is_err());
    let invalid_patch: Event = Event::StateDelta(
        StateDeltaEvent::new(vec![JsonPatchOperation::Remove {
            path: JsonPointer("bad-pointer".into()),
            extra: Default::default(),
        }])
        .with_base(base()),
    );
    assert!(encode(&invalid_patch).is_err());
}
#[test]
fn empty_text_delta_is_legal_in_public_constructor_and_encoder() {
    let event: Event =
        Event::TextMessageContent(TextMessageContentEvent::new("m", String::new()).unwrap());
    assert_eq!(payload(&encode(&event).unwrap())["delta"], "");
}
#[test]
fn patch_extra_members_survive_actual_sse_bytes() {
    for wire in [
        json!({"type":"STATE_DELTA","delta":[{"op":"remove","path":"/x","value":null,"extension":{"v":[null]}}]}),
        json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"work","patch":[{"op":"add","path":"/x","value":null,"extension":{"v":[null]}}]}),
    ] {
        assert_eq!(payload(&encode(&event(wire.clone())).unwrap()), wire);
    }
}

#[test]
fn every_constructible_optional_json_null_is_normalized_at_producer_boundary() {
    let mut input: RunAgentInput =
        serde_json::from_value(json!({"threadId":"t","runId":"r","messages":[]})).unwrap();
    input.state = Value::Null;
    input.forwarded_props = Value::Null;
    input.tools = Some(vec![Tool::new("f".into(), "tool".into(), Value::Null)]);
    input.resume = Some(vec![{
        let mut value = ResumeEntry::new("i".into(), ResumeStatus::Resolved);
        value.payload = Some(Value::Null);
        value.metadata = Some(serde_json::Map::from_iter([("nested".into(), Value::Null)]));
        value
    }]);
    let started: Event = Event::RunStarted(Box::new({
        let mut value = RunStartedEvent::new("t", "r").with_base(base());
        value.input = Some(input);
        value
    }));
    let output = payload(&encode(&started).unwrap());
    assert_eq!(
        output,
        json!({"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"f","description":"tool"}],"resume":[{"interruptId":"i","status":"resolved","metadata":{"nested":null}}]}})
    );
    let finished: Event = Event::SubagentFinished({
        let mut value = SubagentFinishedEvent::new("s".into()).with_base(base());
        value.result = Some(Value::Null);
        value
    });
    assert_eq!(
        payload(&encode(&finished).unwrap()),
        json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"})
    );
    for source in [
        PartSource::Data {
            value: "YQ==".into(),
            mime_type: "image/png".into(),
        },
        PartSource::Url {
            value: "https://example.invalid/media".into(),
            mime_type: None,
        },
        PartSource::File {
            value: "provider-file".into(),
            provider: Some("vendor".into()),
            mime_type: None,
        },
    ] {
        let parts = vec![
            ContentPart::Image {
                source: source.clone(),
                id: Some("image".into()),
                metadata: Some(Value::Null),
            },
            ContentPart::Audio {
                source: source.clone(),
                id: None,
                metadata: Some(Value::Null),
            },
            ContentPart::Video {
                source: source.clone(),
                id: None,
                metadata: Some(Value::Null),
            },
            ContentPart::Document {
                source: source.clone(),
                id: None,
                metadata: Some(Value::Null),
            },
        ];
        let result: Event = Event::ToolCallResult({
            let mut value =
                ToolCallResultEvent::new("m", "c", MessageContent::Parts(parts)).with_base(base());
            value.role = Some(Role::Tool);
            value
        });
        let output = payload(&encode(&result).unwrap());
        for part in output["content"].as_array().unwrap() {
            assert!(part.get("metadata").is_none());
            assert_eq!(part["source"], serde_json::to_value(&source).unwrap());
        }
    }
}
