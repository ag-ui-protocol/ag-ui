//! A registered optional `null` arriving at the client reads as an omitted field.
//!
//! AG-UI 1.0 lists the optional members a pre-1.0 producer sent as `null`
//! (upstream `DEPRECATIONS.md`, the "`X: null` → omit the field" rows). For each
//! row, an event carrying the explicit `null` decodes to the same typed event as
//! the one without the field. A `null` anywhere else is still a protocol
//! violation. Upstream fixtures are used where the corpus has one for the shape.
#![cfg(all(feature = "client", feature = "sse"))]

use ag_ui::Event;
use ag_ui::client::transport::decode_events;
use futures_util::{FutureExt, StreamExt, stream};
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../../../../spec/1.0/fixtures/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn decode(event: &Value) -> ag_ui::client::Result<Event> {
    let frame = ag_ui::encode::sse::frame(&event.to_string());
    let mut events = decode_events(stream::iter([Ok::<_, std::io::Error>(frame.into_bytes())]))
        .collect::<Vec<_>>()
        .now_or_never()
        .expect("an in-memory stream is ready at once");
    assert_eq!(events.len(), 1, "{event}");
    events.remove(0)
}

/// `event` with the member at `pointer` removed.
fn without(event: &Value, pointer: &str) -> Value {
    let (parent, field) = pointer.rsplit_once('/').unwrap();
    let mut omitted = event.clone();
    let removed = omitted
        .pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .and_then(|object| object.remove(field));
    assert_eq!(
        removed,
        Some(Value::Null),
        "{pointer} is not null in {event}"
    );
    omitted
}

fn run_started_input(input: Value) -> Value {
    let mut base = json!({"threadId": "t1", "runId": "r1", "messages": []});
    base.as_object_mut()
        .unwrap()
        .extend(input.as_object().unwrap().clone());
    json!({"type": "RUN_STARTED", "threadId": "t1", "runId": "r1", "input": base})
}

fn media(kind: &str) -> Value {
    json!({
        "type": kind,
        "source": {"type": "url", "value": "https://example.com/attachment"},
        "metadata": null
    })
}

fn run_finished_usage(field: &str) -> Value {
    let mut entry = json!({"model": "model", "inputTokens": 1, "outputTokens": 2});
    entry[field] = Value::Null;
    json!({"type": "RUN_FINISHED", "threadId": "t1", "runId": "r1", "usage": [entry]})
}

/// Every registered shape: the row, an event carrying the `null`, and where.
fn registry() -> Vec<(&'static str, Value, &'static str)> {
    let image = run_started_input(json!({"messages": [
        {"id": "m1", "role": "user", "content": [media("image")]}
    ]}));
    let audio = run_started_input(json!({"messages": [
        {"id": "m1", "role": "user", "content": [media("audio")]}
    ]}));
    let video = run_started_input(json!({"messages": [
        {"id": "m1", "role": "user", "content": [media("video")]}
    ]}));
    let document = run_started_input(json!({"messages": [
        {"id": "m1", "role": "user", "content": [media("document")]}
    ]}));
    vec![
        (
            "parentMessageId: null on TOOL_CALL_START",
            fixture("ToolCallStartEvent/invalid/parent-message-id-null"),
            "/parentMessageId",
        ),
        (
            "parentMessageId: null on TOOL_CALL_CHUNK",
            fixture("ToolCallChunkEvent/invalid/parent-message-id-null"),
            "/parentMessageId",
        ),
        (
            "outcome: null on RUN_FINISHED",
            fixture("RunFinishedEvent/invalid/outcome-null"),
            "/outcome",
        ),
        (
            "rawEvent: null on an event",
            fixture("TextMessageEndEvent/invalid/raw-event-null"),
            "/rawEvent",
        ),
        (
            "result: null on RUN_FINISHED",
            json!({"type": "RUN_FINISHED", "threadId": "t1", "runId": "r1", "result": null}),
            "/result",
        ),
        (
            "result: null on SUBAGENT_FINISHED",
            json!({"type": "SUBAGENT_FINISHED", "subagentRunId": "s1", "result": null}),
            "/result",
        ),
        (
            "payload: null on a resume entry",
            run_started_input(json!({"resume": [
                {"interruptId": "i1", "status": "resolved", "payload": null}
            ]})),
            "/input/resume/0/payload",
        ),
        (
            "metadata: null on an image content part",
            image,
            "/input/messages/0/content/0/metadata",
        ),
        (
            "metadata: null on an audio content part",
            audio,
            "/input/messages/0/content/0/metadata",
        ),
        (
            "metadata: null on a video content part",
            video,
            "/input/messages/0/content/0/metadata",
        ),
        (
            "metadata: null on a document content part",
            document,
            "/input/messages/0/content/0/metadata",
        ),
        (
            "parameters: null on a tool",
            run_started_input(json!({"tools": [
                {"name": "lookup", "description": "Lookup", "parameters": null}
            ]})),
            "/input/tools/0/parameters",
        ),
        (
            "forwardedProps: null on RunAgentInput",
            run_started_input(json!({"forwardedProps": null})),
            "/input/forwardedProps",
        ),
        (
            "subagentRunId: null on an event",
            fixture("TextMessageContentEvent/invalid/subagent-run-id-null"),
            "/subagentRunId",
        ),
        (
            "parentRunId: null on RUN_STARTED",
            json!({"type": "RUN_STARTED", "threadId": "t1", "runId": "r1", "parentRunId": null}),
            "/parentRunId",
        ),
        (
            "input: null on RUN_STARTED",
            json!({"type": "RUN_STARTED", "threadId": "t1", "runId": "r1", "input": null}),
            "/input",
        ),
        (
            "role: null on TOOL_CALL_RESULT",
            json!({
                "type": "TOOL_CALL_RESULT", "messageId": "m1", "toolCallId": "c1",
                "content": "done", "role": null
            }),
            "/role",
        ),
        (
            "pendingToolCallIds: null on a RUN_FINISHED outcome",
            json!({
                "type": "RUN_FINISHED", "threadId": "t1", "runId": "r1",
                "outcome": {"type": "success", "pendingToolCallIds": null}
            }),
            "/outcome/pendingToolCallIds",
        ),
        (
            "provider: null on a RUN_FINISHED usage entry",
            run_finished_usage("provider"),
            "/usage/0/provider",
        ),
        (
            "reasoningTokens: null on a RUN_FINISHED usage entry",
            run_finished_usage("reasoningTokens"),
            "/usage/0/reasoningTokens",
        ),
        (
            "cachedInputTokens: null on a RUN_FINISHED usage entry",
            run_finished_usage("cachedInputTokens"),
            "/usage/0/cachedInputTokens",
        ),
        (
            "cacheWriteInputTokens: null on a RUN_FINISHED usage entry",
            run_finished_usage("cacheWriteInputTokens"),
            "/usage/0/cacheWriteInputTokens",
        ),
        (
            "usage: null on RUN_ERROR",
            json!({"type": "RUN_ERROR", "message": "boom", "usage": null}),
            "/usage",
        ),
    ]
}

#[test]
fn every_registered_optional_null_decodes_as_the_omitted_field() {
    let registry = registry();
    assert_eq!(registry.len(), 23, "one case per DEPRECATIONS.md row");
    let mut failures = Vec::new();
    for (row, with_null, pointer) in registry {
        let omitted = without(&with_null, pointer);
        let expected = decode(&omitted).unwrap_or_else(|error| panic!("{row}: {error}"));
        match decode(&with_null) {
            Ok(actual) if actual == expected => {}
            Ok(actual) => failures.push(format!("{row}: decoded {actual:?}, not {expected:?}")),
            Err(error) => failures.push(format!("{row}: {error}")),
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn media_part_metadata_null_is_omitted_in_a_messages_snapshot_too() {
    for kind in ["image", "audio", "video", "document"] {
        let snapshot = json!({"type": "MESSAGES_SNAPSHOT", "messages": [
            {"id": "m1", "role": "user", "content": [media(kind)]}
        ]});
        let omitted = without(&snapshot, "/messages/0/content/0/metadata");
        assert_eq!(
            decode(&snapshot).unwrap_or_else(|error| panic!("{kind}: {error}")),
            decode(&omitted).unwrap(),
            "{kind}"
        );
    }
}

#[test]
fn an_optional_null_outside_the_registry_is_still_a_protocol_violation() {
    let message = |content: Value| json!({"id": "m1", "role": "user", "content": content});
    for (event, field) in [
        // Upstream's invalid fixtures for nulls the registry does not list.
        (
            fixture("SubagentFinishedEvent/invalid/outcome-null"),
            "/outcome",
        ),
        (
            fixture("SubagentStartedEvent/invalid/description-null"),
            "/description",
        ),
        (fixture("SubagentErrorEvent/invalid/code-null"), "/code"),
        (
            fixture("TextMessageContentEvent/invalid/metadata-null"),
            "/metadata",
        ),
        (
            fixture("MessagesSnapshotEvent/invalid/message-metadata-null"),
            "/messages/0/metadata",
        ),
        // The same fields as registered rows, in places the rows do not name.
        (
            json!({"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": null}),
            "/role",
        ),
        (
            json!({"type": "RUN_ERROR", "message": "boom", "code": null}),
            "/code",
        ),
        (
            json!({"type": "RUN_ERROR", "message": "boom", "usage": [{"provider": null}]}),
            "/usage/0/provider",
        ),
        (
            json!({"type": "RUN_FINISHED", "threadId": "t1", "runId": "r1", "usage": [{"model": null}]}),
            "/usage/0/model",
        ),
        (
            json!({"type": "RUN_STARTED", "threadId": "t1", "runId": "r1", "protocolVersion": null}),
            "/protocolVersion",
        ),
        (
            run_started_input(json!({"parentRunId": null})),
            "/input/parentRunId",
        ),
        (
            run_started_input(json!({"messages": [message(json!([
                {"type": "text", "text": "hi", "metadata": null}
            ]))]})),
            "/input/messages/0/content/0/metadata",
        ),
        (
            run_started_input(json!({"resume": [
                {"interruptId": "i1", "status": "resolved", "metadata": null}
            ]})),
            "/input/resume/0/metadata",
        ),
    ] {
        let error = decode(&event).expect_err(&event.to_string());
        assert!(
            matches!(error, ag_ui::client::Error::Protocol(_)),
            "{event}: {error}"
        );
        assert!(error.to_string().contains(field), "{event}: {error}");
    }
}
