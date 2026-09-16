//! The subagent surface and metadata: the three lifecycle events, attribution
//! on the 24 events that carry it, the fields that reached messages,
//! interrupts and resume entries, and the no-null rule they all share.

#![allow(deprecated)]

use ag_ui::metadata::merge_metadata_into;
use ag_ui::*;
use serde_json::{Value, json};

fn object(value: Value) -> JsonObject {
    value.as_object().expect("an object literal").clone()
}

fn tag(event: &Event) -> Option<&str> {
    event.subagent_run_id().map(SubagentRunId::as_str)
}

#[test]
fn subagent_started_round_trips_with_every_field() {
    let text = r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"researcher","description":"Finds sources","parentSubagentRunId":"sub-0","parentToolCallId":"call-1","parentMessageId":"msg-1"}"#;
    let event: Event = serde_json::from_str(text).unwrap();

    let Event::SubagentStarted(payload) = &event else {
        panic!("wrong variant");
    };
    assert_eq!(payload.subagent_run_id.as_str(), "sub-1");
    assert_eq!(payload.name, "researcher");
    assert_eq!(payload.description.as_deref(), Some("Finds sources"));
    assert_eq!(payload.parent_subagent_run_id.as_deref(), Some("sub-0"));
    assert_eq!(payload.parent_tool_call_id.as_deref(), Some("call-1"));
    assert_eq!(payload.parent_message_id.as_deref(), Some("msg-1"));
    assert_eq!(serde_json::to_string(&event).unwrap(), text);

    let built = Event::SubagentStarted(
        SubagentStartedEvent::new("sub-1", "researcher")
            .with_description("Finds sources")
            .with_parent_subagent("sub-0")
            .with_parent_tool_call("call-1")
            .with_parent_message("msg-1"),
    );
    assert_eq!(built, event);

    // The minimal form is what the factory builds.
    assert_eq!(
        serde_json::to_string(&Event::subagent_started("sub-1", "researcher")).unwrap(),
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"researcher"}"#
    );
}

#[test]
fn subagent_finished_reads_every_outcome_shape() {
    let legacy: Event =
        serde_json::from_str(r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1"}"#).unwrap();
    let Event::SubagentFinished(payload) = &legacy else {
        panic!("wrong variant");
    };
    assert_eq!(payload.outcome, None, "absent reads as legacy success");
    assert_eq!(payload.result, None);

    let success: Event = serde_json::from_str(
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","result":{"sources":3},"outcome":{"type":"success"}}"#,
    )
    .unwrap();
    let Event::SubagentFinished(payload) = &success else {
        panic!("wrong variant");
    };
    assert_eq!(payload.result, Some(json!({ "sources": 3 })));
    assert_eq!(payload.outcome, Some(SubagentOutcome::Success));
    assert!(payload.outcome.as_ref().unwrap().interrupt_ids().is_empty());

    let suspended: Event = serde_json::from_str(
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":{"type":"suspended","interruptIds":["int-1"]}}"#,
    )
    .unwrap();
    let Event::SubagentFinished(payload) = &suspended else {
        panic!("wrong variant");
    };
    let outcome = payload.outcome.as_ref().unwrap();
    assert!(outcome.is_suspended());
    assert_eq!(outcome.interrupt_ids(), ["int-1"]);

    // An ancestor suspended because a descendant interrupted owns nothing.
    let bare: Event = serde_json::from_str(
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":{"type":"suspended"}}"#,
    )
    .unwrap();
    let Event::SubagentFinished(payload) = &bare else {
        panic!("wrong variant");
    };
    assert!(payload.outcome.as_ref().unwrap().is_suspended());
    assert!(payload.outcome.as_ref().unwrap().interrupt_ids().is_empty());

    // Newer than the null-tolerance fix, so it never inherits the tolerance.
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":null}"#
        )
        .is_err()
    );

    assert_eq!(
        serde_json::to_string(&Event::subagent_finished_success("sub-1")).unwrap(),
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":{"type":"success"}}"#
    );
    assert_eq!(
        serde_json::to_string(&Event::subagent_finished_suspended(
            "sub-1",
            vec!["int-1".to_owned()]
        ))
        .unwrap(),
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":{"type":"suspended","interruptIds":["int-1"]}}"#
    );
    assert_eq!(
        serde_json::to_string(&Event::subagent_finished("sub-1")).unwrap(),
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1"}"#
    );
}

#[test]
fn subagent_error_round_trips() {
    let text = r#"{"type":"SUBAGENT_ERROR","subagentRunId":"sub-1","message":"rate limited","code":"429"}"#;
    let event: Event = serde_json::from_str(text).unwrap();
    assert_eq!(
        event,
        Event::SubagentError(SubagentErrorEvent::new("sub-1", "rate limited").with_code("429"))
    );
    assert_eq!(serde_json::to_string(&event).unwrap(), text);
    assert_eq!(
        serde_json::to_string(&Event::subagent_error("sub-1", "rate limited")).unwrap(),
        r#"{"type":"SUBAGENT_ERROR","subagentRunId":"sub-1","message":"rate limited"}"#
    );
}

#[test]
fn lifecycle_events_require_their_subject_and_their_required_fields() {
    for text in [
        r#"{"type":"SUBAGENT_STARTED","name":"researcher"}"#,
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1"}"#,
        r#"{"type":"SUBAGENT_FINISHED"}"#,
        r#"{"type":"SUBAGENT_ERROR","subagentRunId":"sub-1"}"#,
        r#"{"type":"SUBAGENT_ERROR","message":"boom"}"#,
    ] {
        assert!(
            serde_json::from_str::<Event>(text).is_err(),
            "{text} should not parse"
        );
    }
}

#[test]
fn twenty_four_of_thirty_six_event_types_carry_attribution() {
    assert_eq!(EventType::ALL.len(), 36);
    let attributable = EventType::ALL
        .iter()
        .filter(|kind| kind.is_attributable())
        .count();
    assert_eq!(attributable, 24);

    for kind in [
        EventType::RunStarted,
        EventType::RunFinished,
        EventType::RunError,
        EventType::MessagesSnapshot,
        EventType::ThinkingStart,
        EventType::ThinkingEnd,
        EventType::ThinkingTextMessageStart,
        EventType::ThinkingTextMessageContent,
        EventType::ThinkingTextMessageEnd,
        EventType::SubagentStarted,
        EventType::SubagentFinished,
        EventType::SubagentError,
    ] {
        assert!(!kind.is_attributable(), "{kind} carries no attribution");
    }
}

#[test]
fn attribution_is_set_read_and_cleared_on_attributable_events() {
    let mut event = Event::text_message_content("m", "hi");
    assert_eq!(tag(&event), None);
    assert!(event.set_subagent_run_id("sub-1"));
    assert_eq!(tag(&event), Some("sub-1"));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"hi","subagentRunId":"sub-1"}"#
    );
    let back: Event = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
    assert_eq!(back, event);

    assert_eq!(event.clear_subagent_run_id().as_deref(), Some("sub-1"));
    assert_eq!(tag(&event), None);
    assert_eq!(event.clear_subagent_run_id(), None);

    let tagged = Event::step_started("plan").with_subagent_run_id("sub-1");
    assert_eq!(tag(&tagged), Some("sub-1"));

    // The field lands on every attributable family, not only text.
    for mut sample in [
        Event::tool_call_start("c", "search"),
        Event::tool_call_result("m", "c", "ok"),
        Event::state_snapshot(json!({})),
        Event::activity_delta("m", "web_search", Vec::<PatchOperation>::new()),
        Event::raw(json!({})),
        Event::custom("confetti", json!(1)),
        Event::step_finished("plan"),
        Event::reasoning_message_chunk(None, Some("hm".into())),
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, "m", "blob"),
    ] {
        assert!(sample.event_type().is_attributable());
        assert!(sample.set_subagent_run_id("sub-2"));
        let json = serde_json::to_value(&sample).unwrap();
        assert_eq!(json["subagentRunId"], "sub-2", "{}", sample.event_type());
        assert_eq!(serde_json::from_value::<Event>(json).unwrap(), sample);
    }
}

#[test]
fn unattributable_events_refuse_the_tag_and_lifecycle_events_carry_a_subject() {
    let mut run = Event::run_started("t", "r");
    assert!(!run.set_subagent_run_id("sub-1"));
    assert_eq!(tag(&run), None);
    assert_eq!(run.clear_subagent_run_id(), None);
    assert!(
        !serde_json::to_string(&run)
            .unwrap()
            .contains("subagentRunId")
    );
    // The builder form is the same no-op.
    assert_eq!(
        Event::run_error("boom").with_subagent_run_id("sub-1"),
        Event::run_error("boom")
    );

    let mut thinking = Event::thinking_start(None);
    assert!(!thinking.set_subagent_run_id("sub-1"));

    let mut started = Event::subagent_started("sub-1", "researcher");
    assert!(!started.event_type().is_attributable());
    assert_eq!(tag(&started), Some("sub-1"), "the subject reads back");
    assert!(started.set_subagent_run_id("sub-2"), "and can be set");
    assert_eq!(tag(&started), Some("sub-2"));
    assert_eq!(started.clear_subagent_run_id(), None, "but never cleared");
    assert_eq!(tag(&started), Some("sub-2"));

    assert_eq!(tag(&Event::subagent_finished("sub-3")), Some("sub-3"));
    assert_eq!(tag(&Event::subagent_error("sub-4", "boom")), Some("sub-4"));
}

#[test]
fn a_null_subagent_run_id_is_rejected_everywhere_it_may_appear() {
    // On an event: absent is the only spelling.
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"hi","subagentRunId":null}"#
        )
        .is_err()
    );
    let absent: Event =
        serde_json::from_str(r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"hi"}"#)
            .unwrap();
    assert_eq!(tag(&absent), None);

    // On a message, including one inside a snapshot.
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m","role":"user","content":"hi","subagentRunId":null}]}"#
        )
        .is_err()
    );
    let tagged: Message = serde_json::from_str(
        r#"{"id":"m","role":"assistant","content":"hi","subagentRunId":"sub-1"}"#,
    )
    .unwrap();
    assert_eq!(
        tagged.subagent_run_id().map(SubagentRunId::as_str),
        Some("sub-1")
    );

    // On an interrupt.
    assert!(
        serde_json::from_str::<Interrupt>(
            r#"{"id":"int-1","reason":"tool_approval","subagentRunId":null}"#
        )
        .is_err()
    );
    let interrupt: Interrupt =
        serde_json::from_str(r#"{"id":"int-1","reason":"tool_approval","subagentRunId":"sub-1"}"#)
            .unwrap();
    assert_eq!(interrupt.subagent_run_id.as_deref(), Some("sub-1"));
    assert_eq!(
        interrupt,
        Interrupt::new("int-1", "tool_approval").with_subagent_run_id("sub-1")
    );

    // On the optional links of SUBAGENT_STARTED, and SUBAGENT_ERROR's code.
    for text in [
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"x","parentSubagentRunId":null}"#,
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"x","parentToolCallId":null}"#,
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"x","parentMessageId":null}"#,
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"x","description":null}"#,
        r#"{"type":"SUBAGENT_ERROR","subagentRunId":"sub-1","message":"boom","code":null}"#,
    ] {
        assert!(
            serde_json::from_str::<Event>(text).is_err(),
            "{text} should not parse"
        );
    }
}

#[test]
fn metadata_is_absent_or_an_object_never_null() {
    // Through the flattened base of an event.
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"TEXT_MESSAGE_END","messageId":"m","metadata":null}"#
        )
        .is_err()
    );
    let absent: Event =
        serde_json::from_str(r#"{"type":"TEXT_MESSAGE_END","messageId":"m"}"#).unwrap();
    assert_eq!(absent.metadata(), None);
    assert!(absent.base().is_empty());

    let empty: Event =
        serde_json::from_str(r#"{"type":"TEXT_MESSAGE_END","messageId":"m","metadata":{}}"#)
            .unwrap();
    assert_eq!(empty.metadata(), Some(&JsonObject::new()));
    assert!(!empty.base().is_empty());

    // A null *value* under a key is data, and the reserved key is just a key.
    // The base is the payload's first field, so its keys serialize right after
    // the tag — the same order every fixture in `upstream_payloads.rs` uses.
    let text = r#"{"type":"TEXT_MESSAGE_END","metadata":{"finishReason":null,"ag-ui":{"usage":{"input":12}}},"messageId":"m"}"#;
    let with_null: Event = serde_json::from_str(text).unwrap();
    let metadata = with_null.metadata().unwrap();
    assert_eq!(metadata["finishReason"], Value::Null);
    assert_eq!(metadata[AGUI_METADATA_KEY]["usage"]["input"], 12);
    assert_eq!(serde_json::to_string(&with_null).unwrap(), text);

    let built = Event::text_message_end("m").with_metadata(object(json!({ "traceId": "abc" })));
    assert_eq!(
        serde_json::to_string(&built).unwrap(),
        r#"{"type":"TEXT_MESSAGE_END","metadata":{"traceId":"abc"},"messageId":"m"}"#
    );

    // On a message.
    assert!(
        serde_json::from_str::<Message>(
            r#"{"id":"m","role":"user","content":"hi","metadata":null}"#
        )
        .is_err()
    );
    let message: Message =
        serde_json::from_str(r#"{"id":"m","role":"user","content":"hi","metadata":{"k":1}}"#)
            .unwrap();
    assert_eq!(message.metadata().unwrap()["k"], 1);

    // On a tool call.
    assert!(
        serde_json::from_str::<ToolCall>(
            r#"{"id":"c","type":"function","function":{"name":"f","arguments":"{}"},"metadata":null}"#
        )
        .is_err()
    );
    let call: ToolCall = serde_json::from_str(
        r#"{"id":"c","type":"function","function":{"name":"f","arguments":"{}"},"metadata":{"k":1}}"#,
    )
    .unwrap();
    assert_eq!(call.metadata.as_ref().unwrap()["k"], 1);

    // On a resume entry.
    assert!(
        serde_json::from_str::<ResumeEntry>(
            r#"{"interruptId":"int-1","status":"resolved","metadata":null}"#
        )
        .is_err()
    );
    let entry: ResumeEntry = serde_json::from_str(
        r#"{"interruptId":"int-1","status":"resolved","metadata":{"signature":"x"}}"#,
    )
    .unwrap();
    assert_eq!(entry.metadata.as_ref().unwrap()["signature"], "x");
    let built = ResumeEntry::resolved("int-1", json!(true))
        .with_metadata(object(json!({ "signature": "x" })));
    assert_eq!(
        serde_json::to_string(&built).unwrap(),
        r#"{"interruptId":"int-1","status":"resolved","payload":true,"metadata":{"signature":"x"}}"#
    );
}

#[test]
fn metadata_rides_the_flattened_base_of_every_family() {
    for event in [
        Event::text_message_start("m", TextMessageRole::Assistant),
        Event::tool_call_args("c", "{"),
        Event::state_delta(Vec::<PatchOperation>::new()),
        Event::messages_snapshot(Vec::<Message>::new()),
        Event::activity_snapshot("m", "web_search", JsonObject::new()),
        Event::raw(json!({})),
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
        Event::step_started("plan"),
        Event::reasoning_start("m"),
        Event::thinking_end(),
        Event::subagent_started("sub-1", "researcher"),
        Event::subagent_finished_success("sub-1"),
        Event::subagent_error("sub-1", "boom"),
    ] {
        let stamped = event
            .clone()
            .with_timestamp(1_700_000_000_000)
            .with_metadata(object(json!({ "traceId": "abc", "retries": 0 })));
        let json = serde_json::to_value(&stamped).unwrap();
        assert_eq!(json["metadata"]["traceId"], "abc", "{}", event.event_type());
        assert_eq!(json["timestamp"], 1_700_000_000_000_i64);
        let back: Event = serde_json::from_value(json).unwrap();
        assert_eq!(back, stamped);

        let bare = serde_json::to_value(&event).unwrap();
        assert!(bare.get("metadata").is_none());
    }
}

#[test]
fn message_accessors_cover_every_role() {
    let activity = Message::Activity(ActivityMessage {
        id: "m".into(),
        activity_type: "web_search".into(),
        ..Default::default()
    });
    let reasoning = Message::Reasoning(ReasoningMessage {
        id: "m".into(),
        content: "hm".into(),
        ..Default::default()
    });
    for mut message in [
        Message::user("m", "hi"),
        Message::assistant("m", "hello"),
        Message::system("m", "be brief"),
        Message::developer("m", "answer in Korean"),
        Message::tool("m", "c", "ok"),
        activity,
        reasoning,
    ] {
        assert_eq!(message.subagent_run_id(), None);
        assert_eq!(message.metadata(), None);

        message.set_subagent_run_id(Some("sub-1".into()));
        merge_metadata_into(message.metadata_mut(), Some(&object(json!({ "k": 1 }))));
        assert_eq!(
            message.subagent_run_id().map(SubagentRunId::as_str),
            Some("sub-1")
        );
        assert_eq!(message.metadata().unwrap()["k"], 1);

        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["subagentRunId"], "sub-1", "{:?}", message.role());
        assert_eq!(json["metadata"]["k"], 1);
        assert_eq!(serde_json::from_value::<Message>(json).unwrap(), message);

        message.set_subagent_run_id(None);
        assert_eq!(message.subagent_run_id(), None);
    }
}

#[test]
fn merge_metadata_is_last_write_wins_and_never_recurses() {
    let existing = object(json!({ "tags": ["a", "b"], "keep": true, "ag-ui": { "x": 1 } }));
    let incoming = object(json!({ "tags": ["z"], "ag-ui": { "y": 2 }, "added": null }));

    let merged = merge_metadata(Some(&existing), Some(&incoming)).unwrap();
    assert_eq!(merged["tags"], json!(["z"]), "replaced, not appended");
    assert_eq!(merged["keep"], true, "untouched keys survive");
    assert_eq!(
        merged[AGUI_METADATA_KEY],
        json!({ "y": 2 }),
        "the reserved key too"
    );
    assert_eq!(merged["added"], Value::Null, "a null value is data");

    assert_eq!(
        merge_metadata(Some(&existing), None),
        Some(existing.clone())
    );
    assert_eq!(merge_metadata(None, Some(&incoming)), Some(incoming));
    assert_eq!(merge_metadata(None, None), None);
}

#[test]
fn nothing_new_is_emitted_when_absent() {
    // A consumer that predates subagents and metadata sees exactly the bytes
    // it always did.
    assert_eq!(
        serde_json::to_string(&Event::text_message_content("msg-1", "Hello")).unwrap(),
        r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}"#
    );
    assert_eq!(
        serde_json::to_string(&ToolCall::new("c", "f", "{}")).unwrap(),
        r#"{"id":"c","type":"function","function":{"name":"f","arguments":"{}"}}"#
    );
    assert_eq!(
        serde_json::to_string(&Interrupt::new("int-1", "tool_approval")).unwrap(),
        r#"{"id":"int-1","reason":"tool_approval"}"#
    );
    assert_eq!(
        serde_json::to_string(&ResumeEntry::cancelled("int-1")).unwrap(),
        r#"{"interruptId":"int-1","status":"cancelled"}"#
    );
    let message = serde_json::to_string(&Message::user("m", "hi")).unwrap();
    assert!(!message.contains("subagentRunId") && !message.contains("metadata"));
}

#[test]
fn a_null_interrupt_id_list_is_rejected() {
    // Upstream's schema is `z.array(z.string()).optional()`, and its verifier
    // names `outcome.interruptIds: null` explicitly.
    let error = serde_json::from_str::<Event>(
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":{"type":"suspended","interruptIds":null}}"#,
    )
    .expect_err("null is not an absent list");
    assert!(error.to_string().contains("null"), "{error}");

    // Absent and empty both still parse.
    for body in [
        r#"{"type":"suspended"}"#,
        r#"{"type":"suspended","interruptIds":[]}"#,
    ] {
        let event: Event = serde_json::from_str(&format!(
            r#"{{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","outcome":{body}}}"#
        ))
        .expect("parses");
        let Event::SubagentFinished(finished) = event else {
            unreachable!()
        };
        assert!(finished.outcome.expect("an outcome").is_suspended());
    }
}
