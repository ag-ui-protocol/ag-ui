//! Conformance against the upstream schemas, driven by wire payloads rather
//! than by Rust values.
//!
//! Every other test in this crate builds a Rust value, serializes it, and reads
//! it back. That proves the types are self-consistent and nothing else: a field
//! misspelled on the wire round-trips perfectly through its own mistake. The
//! tests here start from JSON text transcribed from the upstream schemas —
//! `sdks/typescript/packages/core/src/{events,types,capabilities}.ts` and their
//! Pydantic counterparts in `sdks/python/ag_ui/core/` — so a wrong name, a wrong
//! optionality, or a wrong number type shows up as a failure rather than as a
//! matching pair of errors.
//!
//! Two kinds of assertion:
//!
//! - **Byte-for-byte round-trip.** Payloads written in this crate's own key
//!   order must deserialize and re-serialize to exactly the same bytes. JSON key
//!   order is not semantic, so the fixtures are ordered to match; what is being
//!   tested is that no field is dropped, renamed, retyped, or invented.
//! - **Field census.** The exact set of keys each event emits, checked against
//!   the upstream schema's field list. This is what catches an invented field or
//!   a `rename_all` that never fired.

#![allow(deprecated)]

use std::collections::BTreeSet;

use ag_ui::*;
use serde_json::{Value, json};

/// Payloads in this crate's canonical key order: the `type` tag, then the
/// flattened [`BaseEvent`] fields, then the payload's own fields in declaration
/// order. Names and value types come from the upstream schemas.
const EVENT_PAYLOADS: &[(&str, &str)] = &[
    (
        "TEXT_MESSAGE_START",
        r#"{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"developer","name":"Ada","subagentRunId":"sub-1"}"#,
    ),
    (
        "TEXT_MESSAGE_CONTENT",
        r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello","subagentRunId":"sub-1"}"#,
    ),
    (
        "TEXT_MESSAGE_END",
        r#"{"type":"TEXT_MESSAGE_END","messageId":"msg-1","subagentRunId":"sub-1"}"#,
    ),
    (
        "TEXT_MESSAGE_CHUNK",
        r#"{"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","role":"user","delta":"Hi","name":"Ada","subagentRunId":"sub-1"}"#,
    ),
    (
        "TOOL_CALL_START",
        r#"{"type":"TOOL_CALL_START","toolCallId":"call-1","toolCallName":"get_weather","parentMessageId":"msg-1","subagentRunId":"sub-1"}"#,
    ),
    (
        "TOOL_CALL_ARGS",
        r#"{"type":"TOOL_CALL_ARGS","toolCallId":"call-1","delta":"{\"city\":","subagentRunId":"sub-1"}"#,
    ),
    (
        "TOOL_CALL_END",
        r#"{"type":"TOOL_CALL_END","toolCallId":"call-1","subagentRunId":"sub-1"}"#,
    ),
    (
        "TOOL_CALL_CHUNK",
        r#"{"type":"TOOL_CALL_CHUNK","toolCallId":"call-1","toolCallName":"get_weather","parentMessageId":"msg-1","delta":"{}","subagentRunId":"sub-1"}"#,
    ),
    (
        "TOOL_CALL_RESULT",
        r#"{"type":"TOOL_CALL_RESULT","messageId":"msg-2","toolCallId":"call-1","content":"18C","role":"tool","subagentRunId":"sub-1"}"#,
    ),
    (
        "THINKING_START",
        r#"{"type":"THINKING_START","title":"Planning"}"#,
    ),
    ("THINKING_END", r#"{"type":"THINKING_END"}"#),
    (
        "THINKING_TEXT_MESSAGE_START",
        r#"{"type":"THINKING_TEXT_MESSAGE_START"}"#,
    ),
    (
        "THINKING_TEXT_MESSAGE_CONTENT",
        r#"{"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"checking"}"#,
    ),
    (
        "THINKING_TEXT_MESSAGE_END",
        r#"{"type":"THINKING_TEXT_MESSAGE_END"}"#,
    ),
    (
        "STATE_SNAPSHOT",
        r#"{"type":"STATE_SNAPSHOT","snapshot":{"counter":1,"items":["a"]},"subagentRunId":"sub-1"}"#,
    ),
    (
        "STATE_DELTA",
        r#"{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/counter","value":2},{"op":"remove","path":"/stale"},{"op":"move","from":"/a","path":"/b"}],"subagentRunId":"sub-1"}"#,
    ),
    (
        "MESSAGES_SNAPSHOT",
        r#"{"type":"MESSAGES_SNAPSHOT","messages":[{"role":"user","id":"msg-0","content":"hi"},{"role":"assistant","id":"msg-1","content":"hello"}]}"#,
    ),
    (
        "ACTIVITY_SNAPSHOT",
        r#"{"type":"ACTIVITY_SNAPSHOT","messageId":"msg-3","activityType":"web_search","content":{"query":"rust","results":3},"replace":false,"subagentRunId":"sub-1"}"#,
    ),
    (
        "ACTIVITY_DELTA",
        r#"{"type":"ACTIVITY_DELTA","messageId":"msg-3","activityType":"web_search","patch":[{"op":"add","path":"/results","value":4}],"subagentRunId":"sub-1"}"#,
    ),
    (
        "RAW",
        r#"{"type":"RAW","event":{"chunk":1,"provider":"openai"},"source":"openai","subagentRunId":"sub-1"}"#,
    ),
    (
        "CUSTOM",
        r#"{"type":"CUSTOM","name":"confetti","value":{"count":100},"subagentRunId":"sub-1"}"#,
    ),
    (
        "RUN_STARTED",
        r#"{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1","parentRunId":"run-0"}"#,
    ),
    (
        "RUN_FINISHED",
        r#"{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1","result":{"ok":true},"outcome":{"type":"success"},"usage":[{"provider":"anthropic","model":"claude-opus-5","inputTokens":1200,"outputTokens":340,"totalTokens":1540,"reasoningTokens":90,"cachedInputTokens":800}]}"#,
    ),
    (
        "RUN_ERROR",
        r#"{"type":"RUN_ERROR","message":"upstream refused","code":"UPSTREAM_DOWN","usage":[{"provider":"openai","inputTokens":10}]}"#,
    ),
    (
        "STEP_STARTED",
        r#"{"type":"STEP_STARTED","stepName":"plan","subagentRunId":"sub-1"}"#,
    ),
    (
        "STEP_FINISHED",
        r#"{"type":"STEP_FINISHED","stepName":"plan","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_START",
        r#"{"type":"REASONING_START","messageId":"msg-4","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_MESSAGE_START",
        r#"{"type":"REASONING_MESSAGE_START","messageId":"msg-4","role":"reasoning","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_MESSAGE_CONTENT",
        r#"{"type":"REASONING_MESSAGE_CONTENT","messageId":"msg-4","delta":"weighing","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_MESSAGE_END",
        r#"{"type":"REASONING_MESSAGE_END","messageId":"msg-4","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_MESSAGE_CHUNK",
        r#"{"type":"REASONING_MESSAGE_CHUNK","messageId":"msg-4","delta":"weighing","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_END",
        r#"{"type":"REASONING_END","messageId":"msg-4","subagentRunId":"sub-1"}"#,
    ),
    (
        "REASONING_ENCRYPTED_VALUE",
        r#"{"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","entityId":"call-1","encryptedValue":"b64","subagentRunId":"sub-1"}"#,
    ),
    (
        "SUBAGENT_STARTED",
        r#"{"type":"SUBAGENT_STARTED","subagentRunId":"sub-1","name":"researcher","description":"Finds sources","parentSubagentRunId":"sub-0","parentToolCallId":"call-1","parentMessageId":"msg-1"}"#,
    ),
    (
        "SUBAGENT_FINISHED",
        r#"{"type":"SUBAGENT_FINISHED","subagentRunId":"sub-1","result":{"sources":3},"outcome":{"type":"suspended","interruptIds":["int-1"]}}"#,
    ),
    (
        "SUBAGENT_ERROR",
        r#"{"type":"SUBAGENT_ERROR","subagentRunId":"sub-1","message":"rate limited","code":"429"}"#,
    ),
];

/// Every field each event schema declares, beyond the three [`BaseEvent`] ones,
/// transcribed from `events.ts`. A payload that sets all of them must serialize
/// to exactly this key set: anything missing is a dropped field, anything extra
/// is invented.
const EVENT_FIELDS: &[(&str, &[&str])] = &[
    (
        "TEXT_MESSAGE_START",
        &["messageId", "role", "name", "subagentRunId"],
    ),
    (
        "TEXT_MESSAGE_CONTENT",
        &["messageId", "delta", "subagentRunId"],
    ),
    ("TEXT_MESSAGE_END", &["messageId", "subagentRunId"]),
    (
        "TEXT_MESSAGE_CHUNK",
        &["messageId", "role", "delta", "name", "subagentRunId"],
    ),
    (
        "TOOL_CALL_START",
        &[
            "toolCallId",
            "toolCallName",
            "parentMessageId",
            "subagentRunId",
        ],
    ),
    ("TOOL_CALL_ARGS", &["toolCallId", "delta", "subagentRunId"]),
    ("TOOL_CALL_END", &["toolCallId", "subagentRunId"]),
    (
        "TOOL_CALL_CHUNK",
        &[
            "toolCallId",
            "toolCallName",
            "parentMessageId",
            "delta",
            "subagentRunId",
        ],
    ),
    (
        "TOOL_CALL_RESULT",
        &[
            "messageId",
            "toolCallId",
            "content",
            "role",
            "subagentRunId",
        ],
    ),
    ("THINKING_START", &["title"]),
    ("THINKING_END", &[]),
    ("THINKING_TEXT_MESSAGE_START", &[]),
    ("THINKING_TEXT_MESSAGE_CONTENT", &["delta"]),
    ("THINKING_TEXT_MESSAGE_END", &[]),
    ("STATE_SNAPSHOT", &["snapshot", "subagentRunId"]),
    ("STATE_DELTA", &["delta", "subagentRunId"]),
    ("MESSAGES_SNAPSHOT", &["messages"]),
    (
        "ACTIVITY_SNAPSHOT",
        &[
            "messageId",
            "activityType",
            "content",
            "replace",
            "subagentRunId",
        ],
    ),
    (
        "ACTIVITY_DELTA",
        &["messageId", "activityType", "patch", "subagentRunId"],
    ),
    ("RAW", &["event", "source", "subagentRunId"]),
    ("CUSTOM", &["name", "value", "subagentRunId"]),
    (
        "RUN_STARTED",
        &["threadId", "runId", "parentRunId", "input"],
    ),
    (
        "RUN_FINISHED",
        &["threadId", "runId", "result", "outcome", "usage"],
    ),
    ("RUN_ERROR", &["message", "code", "usage"]),
    ("STEP_STARTED", &["stepName", "subagentRunId"]),
    ("STEP_FINISHED", &["stepName", "subagentRunId"]),
    ("REASONING_START", &["messageId", "subagentRunId"]),
    (
        "REASONING_MESSAGE_START",
        &["messageId", "role", "subagentRunId"],
    ),
    (
        "REASONING_MESSAGE_CONTENT",
        &["messageId", "delta", "subagentRunId"],
    ),
    ("REASONING_MESSAGE_END", &["messageId", "subagentRunId"]),
    (
        "REASONING_MESSAGE_CHUNK",
        &["messageId", "delta", "subagentRunId"],
    ),
    ("REASONING_END", &["messageId", "subagentRunId"]),
    (
        "REASONING_ENCRYPTED_VALUE",
        &["subtype", "entityId", "encryptedValue", "subagentRunId"],
    ),
    (
        "SUBAGENT_STARTED",
        &[
            "subagentRunId",
            "name",
            "description",
            "parentSubagentRunId",
            "parentToolCallId",
            "parentMessageId",
        ],
    ),
    ("SUBAGENT_FINISHED", &["subagentRunId", "result", "outcome"]),
    ("SUBAGENT_ERROR", &["subagentRunId", "message", "code"]),
];

fn keys(value: &Value) -> BTreeSet<&str> {
    value
        .as_object()
        .expect("events serialize as objects")
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn wire_payloads_round_trip_byte_for_byte() {
    for (tag, payload) in EVENT_PAYLOADS {
        let event: Event = serde_json::from_str(payload).unwrap_or_else(|error| {
            panic!("{tag} failed to deserialize: {error}\n  payload: {payload}")
        });
        assert_eq!(event.event_type().as_str(), *tag);
        let reserialized = serde_json::to_string(&event).unwrap();
        assert_eq!(
            reserialized, *payload,
            "{tag} did not survive the round trip"
        );
    }
}

#[test]
fn the_fixture_table_covers_every_event_type() {
    let covered: BTreeSet<&str> = EVENT_PAYLOADS.iter().map(|(tag, _)| *tag).collect();
    let declared: BTreeSet<&str> = EventType::ALL.iter().map(EventType::as_str).collect();
    assert_eq!(covered, declared, "a new event type needs a fixture");

    let censused: BTreeSet<&str> = EVENT_FIELDS.iter().map(|(tag, _)| *tag).collect();
    assert_eq!(censused, declared, "a new event type needs a field census");
}

#[test]
fn base_event_fields_are_the_only_shared_ones() {
    // `timestamp`, `rawEvent` and `metadata` come from BaseEventSchema, and
    // nothing else does. They attach to every event without appearing in any
    // event's own field list.
    for (tag, payload) in EVENT_PAYLOADS {
        let stamped: Value = {
            let event: Event = serde_json::from_str(payload).unwrap();
            serde_json::to_value(
                event
                    .with_timestamp(1_700_000_000_000)
                    .with_raw_event(json!({"upstream": true}))
                    .with_metadata(json!({"traceId": "abc"}).as_object().unwrap().clone()),
            )
            .unwrap()
        };
        assert_eq!(
            stamped["timestamp"],
            json!(1_700_000_000_000_i64),
            "{tag} lost its timestamp, or widened it to a float"
        );
        assert_eq!(stamped["rawEvent"], json!({"upstream": true}), "{tag}");
        assert_eq!(stamped["metadata"], json!({"traceId": "abc"}), "{tag}");
    }
}

#[test]
fn each_event_emits_exactly_the_fields_its_schema_declares() {
    for ((tag, payload), (census_tag, expected)) in EVENT_PAYLOADS.iter().zip(EVENT_FIELDS) {
        assert_eq!(tag, census_tag, "the two tables must stay aligned");

        let event: Event = serde_json::from_str(payload).unwrap();
        let emitted = serde_json::to_value(&event).unwrap();
        let mut actual = keys(&emitted);
        assert!(actual.remove("type"), "{tag} lost its discriminator");

        let expected: BTreeSet<&str> = expected.iter().copied().collect();
        // RUN_STARTED's `input` is the one optional field too large to inline in
        // a fixture; it gets its own test below.
        let expected: BTreeSet<&str> = if *tag == "RUN_STARTED" {
            expected.into_iter().filter(|f| *f != "input").collect()
        } else {
            expected
        };

        assert_eq!(
            actual, expected,
            "{tag} does not emit the fields its upstream schema declares"
        );
    }
}

#[test]
fn run_started_carries_the_full_input_shape() {
    // RunAgentInputSchema, field for field, in this crate's key order.
    let payload = r#"{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1","input":{"threadId":"thread-1","runId":"run-1","parentRunId":"run-0","state":{"counter":0},"messages":[{"role":"system","id":"m0","content":"be brief"}],"tools":[{"name":"get_weather","description":"Look it up","parameters":{"type":"object"},"metadata":{"a2ui":true}}],"context":[{"description":"page","value":"/dashboard"}],"forwardedProps":{"locale":"ko-KR"},"resume":[{"interruptId":"int-1","status":"resolved","payload":{"approved":true}}]}}"#;

    let event: Event = serde_json::from_str(payload).expect("RUN_STARTED input must parse");
    assert_eq!(serde_json::to_string(&event).unwrap(), payload);

    let Event::RunStarted(started) = &event else {
        panic!("wrong variant");
    };
    let input = started.input.as_ref().expect("input present");
    assert!(input.is_resume());
    assert_eq!(
        input.tools[0].metadata.as_ref().unwrap()["a2ui"],
        json!(true)
    );
}

/// One message per role, in this crate's key order, with every field the
/// corresponding upstream schema declares.
const MESSAGE_PAYLOADS: &[(&str, &str)] = &[
    (
        "developer",
        r#"{"role":"developer","id":"m1","content":"internal note","name":"ops","encryptedValue":"z1","subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
    (
        "system",
        r#"{"role":"system","id":"m2","content":"be brief","name":"sys","encryptedValue":"z2","subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
    (
        "assistant",
        r#"{"role":"assistant","id":"m3","content":"on it","name":"bot","encryptedValue":"z3","toolCalls":[{"id":"call-1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Seoul\"}"},"encryptedValue":"z4","metadata":{"k":1}}],"subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
    (
        "user",
        r#"{"role":"user","id":"m4","content":"hello","name":"Ada","encryptedValue":"z5","subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
    (
        "tool",
        r#"{"role":"tool","id":"m5","content":"18C","toolCallId":"call-1","error":"rate limited","encryptedValue":"z6","subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
    (
        "activity",
        r#"{"role":"activity","id":"m6","activityType":"web_search","content":{"query":"rust"},"subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
    (
        "reasoning",
        r#"{"role":"reasoning","id":"m7","content":"weighing options","encryptedValue":"z7","subagentRunId":"sub-1","metadata":{"traceId":"abc"}}"#,
    ),
];

#[test]
fn every_message_role_round_trips_byte_for_byte() {
    for (role, payload) in MESSAGE_PAYLOADS {
        let message: Message = serde_json::from_str(payload)
            .unwrap_or_else(|error| panic!("{role} failed to deserialize: {error}"));
        assert_eq!(message.role().as_str(), *role);
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            *payload,
            "{role} did not survive the round trip"
        );
    }
}

#[test]
fn the_message_fixtures_cover_every_role() {
    let covered: BTreeSet<&str> = MESSAGE_PAYLOADS.iter().map(|(role, _)| *role).collect();
    let declared: BTreeSet<&str> = [
        "developer",
        "system",
        "assistant",
        "user",
        "tool",
        "activity",
        "reasoning",
    ]
    .into_iter()
    .collect();
    assert_eq!(covered, declared);
}

#[test]
fn tool_and_activity_messages_carry_no_inherited_fields() {
    // ToolMessageSchema, ActivityMessageSchema and ReasoningMessageSchema are
    // standalone objects upstream, not extensions of BaseMessageSchema, so they
    // must not grow a `name`.
    for payload in [
        r#"{"role":"tool","id":"m5","content":"18C","toolCallId":"call-1"}"#,
        r#"{"role":"activity","id":"m6","activityType":"search","content":{}}"#,
        r#"{"role":"reasoning","id":"m7","content":"thinking"}"#,
    ] {
        let message: Message = serde_json::from_str(payload).unwrap();
        let emitted = serde_json::to_value(&message).unwrap();
        assert!(
            !keys(&emitted).contains("name"),
            "{} must not carry a name",
            message.role()
        );
    }
}

#[test]
fn multimodal_user_content_round_trips_every_part_type() {
    // InputContentSchema's whole discriminated union, plus both source forms.
    let payload = r#"{"role":"user","id":"m1","content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"url","value":"https://x/y.png","mimeType":"image/png"}},{"type":"audio","source":{"type":"data","value":"AAAA","mimeType":"audio/wav"}},{"type":"video","source":{"type":"url","value":"https://x/y.mp4"}},{"type":"document","source":{"type":"data","value":"JVBER","mimeType":"application/pdf"},"metadata":{"pages":3}},{"type":"binary","mimeType":"image/gif","id":"blob-1","url":"https://x/y.gif","data":"R0lG","filename":"y.gif"}]}"#;

    let message: Message = serde_json::from_str(payload).expect("every part type must parse");
    assert_eq!(serde_json::to_string(&message).unwrap(), payload);

    let Message::User(user) = &message else {
        panic!("wrong variant");
    };
    let UserContent::Parts(parts) = &user.content else {
        panic!("expected multimodal parts");
    };
    assert_eq!(parts.len(), 6);
}

#[test]
fn a_bare_string_is_still_valid_user_content() {
    let message: Message =
        serde_json::from_str(r#"{"role":"user","id":"m1","content":"just text"}"#).unwrap();
    let Message::User(user) = &message else {
        panic!("wrong variant");
    };
    assert_eq!(user.content, UserContent::Text("just text".into()));
}

#[test]
fn capability_caps_stay_integers_on_the_wire() {
    // `maxIterations` and `maxExecutionTime` are `Optional[int]` in the Python
    // SDK. Typing them as `f64` here would re-emit a received `10` as `10.0`,
    // rewriting a payload a Rust proxy only meant to forward.
    let payload =
        r#"{"codeExecution":true,"sandboxed":true,"maxIterations":10,"maxExecutionTime":30000}"#;
    let execution: ExecutionCapabilities = serde_json::from_str(payload).unwrap();
    assert_eq!(execution.max_iterations, Some(10));
    assert_eq!(execution.max_execution_time, Some(30_000));
    assert_eq!(serde_json::to_string(&execution).unwrap(), payload);

    // Frameworks that spell "no limit" as -1 must not fail the whole document.
    let unlimited: ExecutionCapabilities = serde_json::from_str(r#"{"maxIterations":-1}"#).unwrap();
    assert_eq!(unlimited.max_iterations, Some(-1));
}

#[test]
fn the_whole_capability_snapshot_round_trips() {
    // AgentCapabilitiesSchema, every category populated, in this crate's order.
    let payload = r#"{"identity":{"name":"Weather","type":"langgraph","description":"Forecasts","version":"1.2.0","provider":"acme","documentationUrl":"https://acme.example/docs","metadata":{"tier":"beta"}},"transport":{"streaming":true,"websocket":false,"httpBinary":false,"pushNotifications":false,"resumable":true},"tools":{"supported":true,"items":[{"name":"get_weather","description":"Look it up","parameters":{"type":"object"}}],"parallelCalls":true,"clientProvided":true},"output":{"structuredOutput":true,"supportedMimeTypes":["application/json"]},"state":{"snapshots":true,"deltas":true,"memory":false,"persistentState":true},"multiAgent":{"supported":true,"delegation":true,"handoffs":false,"subAgents":[{"name":"geocoder","description":"Resolves place names"}]},"reasoning":{"supported":true,"streaming":true,"encrypted":false},"multimodal":{"input":{"image":true,"audio":false,"video":false,"pdf":true,"file":true},"output":{"image":false,"audio":false}},"execution":{"codeExecution":false,"sandboxed":false,"maxIterations":25,"maxExecutionTime":120000},"humanInTheLoop":{"supported":true,"approvals":true,"interventions":false,"feedback":true,"interrupts":true,"approveWithEdits":true},"custom":{"vendor":"acme"}}"#;

    let capabilities: AgentCapabilities =
        serde_json::from_str(payload).expect("the capability snapshot must parse");
    assert_eq!(serde_json::to_string(&capabilities).unwrap(), payload);

    // `type` is a Rust keyword, so the field is named `kind`; the rename is the
    // only thing keeping it on the wire.
    assert_eq!(
        capabilities.identity.as_ref().unwrap().kind.as_deref(),
        Some("langgraph")
    );
}

#[test]
fn the_interrupt_protocol_round_trips_in_both_directions() {
    // RUN_FINISHED pauses the run...
    let paused = r#"{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"interrupt","interrupts":[{"id":"int-1","reason":"tool_approval","message":"Send the email?","toolCallId":"call-1","responseSchema":{"type":"object"},"expiresAt":"2026-01-01T00:00:00Z","metadata":{"severity":"high"}}]}}"#;
    let event: Event = serde_json::from_str(paused).expect("interrupt outcome must parse");
    assert_eq!(serde_json::to_string(&event).unwrap(), paused);

    let Event::RunFinished(finished) = &event else {
        panic!("wrong variant");
    };
    finished.outcome.as_ref().unwrap().validate().unwrap();

    // ...and the next request answers it.
    let resumed = r#"{"interruptId":"int-1","status":"cancelled"}"#;
    let entry: ResumeEntry = serde_json::from_str(resumed).unwrap();
    assert_eq!(entry.status, ResumeStatus::Cancelled);
    assert_eq!(serde_json::to_string(&entry).unwrap(), resumed);
}

/// Payloads that real producers emit and that must not fail, even though this
/// crate re-serializes them in a normalized form.
#[test]
fn producer_quirks_are_absorbed_rather_than_fatal() {
    // The .NET adapter's System.Text.Json writes absent optionals as null.
    let event: Event = serde_json::from_str(
        r#"{"type":"TOOL_CALL_START","toolCallId":"c","toolCallName":"t","parentMessageId":null}"#,
    )
    .expect("a null optional must read as absent");
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"TOOL_CALL_START","toolCallId":"c","toolCallName":"t"}"#
    );

    // Pydantic's `model_dump()` without `exclude_none` writes a null outcome.
    let event: Event = serde_json::from_str(
        r#"{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":null}"#,
    )
    .expect("a null outcome must read as absent");
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"RUN_FINISHED","threadId":"t","runId":"r"}"#
    );

    // Both schemas default `role` to assistant and `replace` to true, and both
    // make the default explicit once parsed.
    let event: Event =
        serde_json::from_str(r#"{"type":"TEXT_MESSAGE_START","messageId":"m"}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}"#
    );

    let event: Event = serde_json::from_str(
        r#"{"type":"ACTIVITY_SNAPSHOT","messageId":"m","activityType":"a","content":{}}"#,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"ACTIVITY_SNAPSHOT","messageId":"m","activityType":"a","content":{},"replace":true}"#
    );

    // A ToolCall without the `type` literal — OpenAI-shaped payloads relayed by
    // adapters that drop it.
    let message: Message = serde_json::from_str(
        r#"{"role":"assistant","id":"m","toolCalls":[{"id":"c","function":{"name":"n","arguments":"{}"}}]}"#,
    )
    .expect("the type literal must default");
    let Message::Assistant(assistant) = &message else {
        panic!("wrong variant");
    };
    assert_eq!(
        assistant.tool_calls.as_ref().unwrap()[0].kind,
        ToolCallKind::Function
    );
}

#[test]
fn required_fields_are_not_quietly_optional() {
    // Each of these omits exactly one field the upstream schema requires.
    // Accepting any of them would mean a malformed event reaching application
    // code as a valid one with an empty string in place of the missing value.
    for payload in [
        r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m"}"#,
        r#"{"type":"TEXT_MESSAGE_CONTENT","delta":"x"}"#,
        r#"{"type":"TOOL_CALL_START","toolCallId":"c"}"#,
        r#"{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c"}"#,
        r#"{"type":"RUN_STARTED","threadId":"t"}"#,
        r#"{"type":"RUN_ERROR"}"#,
        r#"{"type":"STEP_STARTED"}"#,
        r#"{"type":"REASONING_MESSAGE_START","messageId":"m"}"#,
        r#"{"type":"REASONING_ENCRYPTED_VALUE","subtype":"message","entityId":"e"}"#,
        r#"{"type":"ACTIVITY_SNAPSHOT","messageId":"m","activityType":"a"}"#,
        r#"{"type":"CUSTOM","name":"n"}"#,
    ] {
        assert!(
            serde_json::from_str::<Event>(payload).is_err(),
            "a required field was silently optional: {payload}"
        );
    }
}

#[test]
fn string_unions_are_closed() {
    // Upstream spells these as literal unions, so a value outside the set is a
    // parse error rather than an unrecognized string flowing into application
    // code.
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"TEXT_MESSAGE_START","messageId":"m","role":"tool"}"#
        )
        .is_err(),
        "TEXT_MESSAGE_START must reject the tool role"
    );
    assert!(
        serde_json::from_str::<Event>(
            r#"{"type":"REASONING_ENCRYPTED_VALUE","subtype":"thought","entityId":"e","encryptedValue":"v"}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<Message>(r#"{"id":"m","role":"function","content":"x"}"#).is_err()
    );
    assert!(
        serde_json::from_str::<ResumeEntry>(r#"{"interruptId":"i","status":"pending"}"#).is_err()
    );
}

#[test]
fn token_counts_reject_values_the_other_bindings_cannot_encode() {
    // Upstream constrains every count to a non-negative integer, in TypeScript
    // because the protobuf transport writes them through an int64 writer that
    // throws mid-stream otherwise.
    assert!(serde_json::from_str::<TokenUsage>(r#"{"inputTokens":-1}"#).is_err());
    assert!(serde_json::from_str::<TokenUsage>(r#"{"inputTokens":1.5}"#).is_err());
    // A labels-only entry is legal; it just reports nothing.
    let labels: TokenUsage = serde_json::from_str(r#"{"provider":"openai"}"#).unwrap();
    assert!(!labels.has_counts());
}
