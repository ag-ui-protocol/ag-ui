use ag_ui_core::{event::Event, types::*};
use serde_json::{Value, json};

#[test]
fn message_envelopes_and_tool_calls_survive_roundtrip() {
    let envelopes = [
        json!({"id":"d","role":"developer","content":"dev"}),
        json!({"id":"s","role":"system","content":"sys"}),
        json!({"id":"a","role":"assistant","content":"answer","toolCalls":[{"id":"call","type":"function","function":{"name":"search","arguments":"{}"},"metadata":{"vendor":{"nullable":null}},"encryptedValue":"cipher"}]}),
        json!({"id":"u","role":"user","content":"ask"}),
        json!({"id":"t","role":"tool","content":"result","toolCallId":"call"}),
        json!({"id":"x","role":"activity","activityType":"search","content":{"hits":1}}),
        json!({"id":"r","role":"reasoning","content":"thinking"}),
    ];
    let messages: Vec<Value> = envelopes
        .into_iter()
        .map(|mut envelope| {
            envelope["metadata"] = json!({"source":"provider","open":null});
            if envelope["role"] != "activity" {
                envelope["encryptedValue"] = json!("opaque");
            }
            envelope["subagentRunId"] = json!("sub-1");
            envelope
        })
        .collect();
    for wire in &messages {
        let parsed: Message = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *wire);
        for key in ["metadata", "subagentRunId"] {
            let mut invalid = wire.clone();
            invalid[key] = Value::Null;
            assert!(
                serde_json::from_value::<Message>(invalid).is_err(),
                "{} accepted null {key}",
                wire["role"]
            );
        }
    }
    for wire in messages.iter().filter(|wire| wire["role"] != "activity") {
        let mut invalid = wire.clone();
        invalid["encryptedValue"] = Value::Null;
        assert!(serde_json::from_value::<Message>(invalid).is_err());
    }
    let snapshot = json!({"type":"MESSAGES_SNAPSHOT","messages":messages});
    let event: Event = serde_json::from_value(snapshot.clone()).unwrap();
    assert_eq!(serde_json::to_value(event).unwrap(), snapshot);
    let input = json!({"threadId":"thread","runId":"run","messages":snapshot["messages"]});
    let parsed: RunAgentInput = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), input);
    let mut invalid = snapshot.clone();
    invalid["messages"][2]["toolCalls"][0]["metadata"] = Value::Null;
    assert!(serde_json::from_value::<Event>(invalid).is_err());
    let mut invalid = snapshot.clone();
    invalid["messages"][2]["toolCalls"][0]["encryptedValue"] = Value::Null;
    assert!(serde_json::from_value::<Event>(invalid).is_err());
}

#[test]
fn named_start_and_chunk_events_roundtrip_author() {
    let start =
        json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant","name":"Ada"});
    let chunk = json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","role":"assistant","delta":"Hello","name":"Grace"});
    for wire in [&start, &chunk] {
        let event: Event = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(event).unwrap(), *wire);
        let mut invalid = wire.clone();
        invalid["name"] = Value::Null;
        assert!(serde_json::from_value::<Event>(invalid).is_err());
    }
}

#[test]
fn text_part_metadata_accepts_every_non_null_json_shape() {
    for metadata in [
        json!("source"),
        json!(17),
        json!(["a", null]),
        json!({"open":null}),
    ] {
        let wire = json!({"id":"u","role":"user","content":[{"type":"text","text":"x","metadata":metadata}]});
        let message: Message = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(message).unwrap(), wire);
        let tool = json!({"id":"t","role":"tool","toolCallId":"c","content":wire["content"]});
        let parsed: Message = serde_json::from_value(tool.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), tool);
    }
    let invalid =
        json!({"id":"u","role":"user","content":[{"type":"text","text":"x","metadata":null}]});
    assert!(serde_json::from_value::<Message>(invalid).is_err());
}

#[test]
fn all_usage_counts_enforce_json_safe_integer_boundary() {
    const MAX: u64 = 9007199254740991;
    for key in [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "reasoningTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
    ] {
        let valid = json!({key:MAX});
        let parsed: TokenUsage = serde_json::from_value(valid.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), valid);
        for event in [
            json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[valid]}),
            json!({"type":"RUN_ERROR","message":"failure","usage":[valid]}),
        ] {
            assert!(serde_json::from_value::<Event>(event.clone()).is_ok());
            let mut invalid = event;
            invalid["usage"][0][key] = json!(MAX + 1);
            assert!(
                serde_json::from_value::<Event>(invalid).is_err(),
                "{key} accepted over max"
            );
        }
        assert!(serde_json::from_value::<TokenUsage>(json!({key:MAX+1})).is_err());

        let mut constructed = TokenUsage::default();
        set_usage_count(&mut constructed, key, MAX);
        assert_eq!(serde_json::to_value(&constructed).unwrap(), valid);
        let mut finished: Event = serde_json::from_value(json!({
            "type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[valid]
        }))
        .unwrap();
        assert!(serde_json::to_value(&finished).is_ok());
        set_usage_count(&mut constructed, key, MAX + 1);
        assert!(
            serde_json::to_value(&constructed).is_err(),
            "{key} serialized over max"
        );
        if let Event::RunFinished(run) = &mut finished {
            run.usage = Some(vec![constructed]);
        } else {
            unreachable!();
        }
        assert!(
            serde_json::to_value(&finished).is_err(),
            "{key} serialized in RUN_FINISHED over max"
        );
    }
}

fn set_usage_count(usage: &mut TokenUsage, key: &str, value: u64) {
    match key {
        "inputTokens" => usage.input_tokens = Some(value),
        "outputTokens" => usage.output_tokens = Some(value),
        "totalTokens" => usage.total_tokens = Some(value),
        "reasoningTokens" => usage.reasoning_tokens = Some(value),
        "cachedInputTokens" => usage.cached_input_tokens = Some(value),
        "cacheWriteInputTokens" => usage.cache_write_input_tokens = Some(value),
        _ => unreachable!(),
    }
}
