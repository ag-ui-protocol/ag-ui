//! What the compatibility boundary removes or translates is reported to the
//! caller, once per run for each distinct text: as an `Update::Warning` and a
//! `warning` diagnostic on the `Thread` run that saw it, or to the callback of
//! a standalone decoder.
#![cfg(feature = "client")]

use std::cell::RefCell;

use ag_ui::RunAgentInput;
use ag_ui::client::transport::{Transport, TransportFuture, TransportStream, enforce_events};
use ag_ui::client::{RunEnd, RunReport, RunStream, Thread, Update};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};

/// Serves wire JSON as it arrived, so the boundary sees what a producer sent.
struct Wire(Vec<Value>);

impl Transport for Wire {
    fn run(&self, _: RunAgentInput) -> TransportFuture {
        let events = self.0.clone();
        Box::pin(async move {
            Ok(TransportStream::json(stream::iter(
                events.into_iter().map(Ok),
            )))
        })
    }
}

fn started() -> Value {
    json!({"type": "RUN_STARTED", "threadId": "t", "runId": "r"})
}

fn finished() -> Value {
    json!({"type": "RUN_FINISHED", "threadId": "t", "runId": "r"})
}

fn thread(events: Vec<Value>, diagnostic_limit: usize) -> Thread<Wire> {
    let mut thread = Thread::builder(Wire(events), "t")
        .diagnostic_limit(diagnostic_limit)
        .build()
        .unwrap();
    thread.set_next_run_id("r");
    thread
}

async fn report(events: Vec<Value>) -> RunReport {
    thread(events, 100)
        .send("go")
        .unwrap()
        .collect_report()
        .await
}

/// Drains a run, returning its `Update::Warning` texts. Any error fails the test.
async fn warning_updates(run: &mut RunStream<'_, Wire>) -> Vec<String> {
    let mut warnings = Vec::new();
    while let Some(update) = run.next().await {
        match update {
            Update::Warning(warning) => warnings.push(warning),
            Update::Error(error) => panic!("a warning is not an error: {error}"),
            Update::Done(end) => assert_eq!(end, RunEnd::Success { result: None }),
            _ => {}
        }
    }
    warnings
}

fn warnings(report: &RunReport) -> Vec<&str> {
    report
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.kind == "warning")
        .map(|diagnostic| diagnostic.message.as_str())
        .collect()
}

#[tokio::test]
async fn stripped_material_is_reported_and_the_run_survives() {
    let report = report(vec![
        started(),
        json!({"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"}),
        json!({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "hi", "futureProp": 1}),
        json!({"type": "FUTURE_EVENT", "somethingNew": true}),
        json!({"type": "TEXT_MESSAGE_END", "messageId": "m1"}),
        json!({"type": "RUN_FINISHED", "threadId": "t", "runId": "r", "outcome": {"type": "paused"}}),
    ])
    .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let warnings = warnings(&report);
    assert_eq!(warnings.len(), 3, "{warnings:?}");
    assert!(warnings[0].contains("/futureProp"), "{warnings:?}");
    assert!(warnings[1].contains("FUTURE_EVENT"), "{warnings:?}");
    assert!(warnings[2].contains("/outcome"), "{warnings:?}");
    assert_eq!(report.diagnostics.len(), 3, "{:?}", report.diagnostics);
}

#[tokio::test]
async fn a_translated_retired_event_is_reported() {
    let report = report(vec![
        started(),
        json!({"type": "THINKING_START", "title": "Working"}),
        json!({"type": "THINKING_TEXT_MESSAGE_START"}),
        json!({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": "Let me check."}),
        json!({"type": "THINKING_TEXT_MESSAGE_END"}),
        json!({"type": "THINKING_END"}),
        finished(),
    ])
    .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let warnings = warnings(&report);
    for tag in [
        "THINKING_START.title",
        "THINKING_START ",
        "THINKING_TEXT_MESSAGE_START",
        "THINKING_TEXT_MESSAGE_CONTENT",
        "THINKING_TEXT_MESSAGE_END",
        "THINKING_END",
    ] {
        assert!(
            warnings.iter().any(|warning| warning.contains(tag)),
            "{tag}: {warnings:?}"
        );
    }
}

#[tokio::test]
async fn a_newer_protocol_version_is_reported() {
    let report = report(vec![
        json!({"type": "RUN_STARTED", "threadId": "t", "runId": "r", "protocolVersion": "1.1"}),
        finished(),
    ])
    .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let warnings = warnings(&report);
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains("1.1"), "{warnings:?}");
}

/// AG-UI 1.1 is still a draft (`spec/draft/schema.json`; `xtask drift-check
/// --draft` lists it). It adds `encryptedValueType` beside every
/// `encryptedValue` and `error` on `TOOL_CALL_RESULT`. A 1.0 consumer removes
/// both and says so, and keeps the encrypted value itself.
#[tokio::test]
async fn the_1_1_draft_fields_are_stripped_with_a_warning() {
    let opaque = |mut message: Value| {
        message["encryptedValue"] = json!("blob");
        message["encryptedValueType"] = json!("vendor/kind");
        message
    };
    let mut thread = thread(
        vec![
            started(),
            json!({"type": "MESSAGES_SNAPSHOT", "messages": [
                opaque(json!({"id": "u", "role": "user", "content": "hi"})),
                opaque(json!({"id": "s", "role": "system", "content": "be brief"})),
                opaque(json!({"id": "d", "role": "developer", "content": "be kind"})),
                opaque(json!({"id": "a", "role": "assistant", "toolCalls": [opaque(json!({
                    "id": "c1", "type": "function",
                    "function": {"name": "look", "arguments": "{}"}
                }))]})),
                opaque(json!({"id": "t", "role": "tool", "toolCallId": "c1", "content": "ok"})),
                opaque(json!({"id": "r", "role": "reasoning", "content": "hmm"})),
            ]}),
            json!({"type": "REASONING_ENCRYPTED_VALUE", "subtype": "message", "entityId": "r",
                   "encryptedValue": "blob", "encryptedValueType": "vendor/kind"}),
            json!({"type": "TOOL_CALL_START", "toolCallId": "c2", "toolCallName": "look"}),
            json!({"type": "TOOL_CALL_END", "toolCallId": "c2"}),
            json!({"type": "TOOL_CALL_RESULT", "messageId": "t2", "toolCallId": "c2",
                   "content": "partial", "error": "timed out"}),
            finished(),
        ],
        100,
    );
    let mut run = thread.send("go").unwrap();
    assert_eq!(
        warning_updates(&mut run).await,
        [
            "unrecognised property at /messages/0/encryptedValueType",
            "unrecognised property at /messages/1/encryptedValueType",
            "unrecognised property at /messages/2/encryptedValueType",
            "unrecognised property at /messages/3/toolCalls/0/encryptedValueType",
            "unrecognised property at /messages/3/encryptedValueType",
            "unrecognised property at /messages/4/encryptedValueType",
            "unrecognised property at /messages/5/encryptedValueType",
            "unrecognised property at /encryptedValueType",
            "unrecognised property at /error",
        ]
    );
    drop(run);

    let messages = serde_json::to_value(thread.messages()).unwrap();
    let text = messages.to_string();
    assert!(!text.contains("encryptedValueType"), "{messages:#}");
    for message in messages.as_array().unwrap().iter().take(6) {
        assert_eq!(message["encryptedValue"], "blob", "{message:#}");
    }
    assert_eq!(messages[3]["toolCalls"][0]["encryptedValue"], "blob");
    let result = messages.as_array().unwrap().last().unwrap();
    assert_eq!(result["id"], "t2", "{messages:#}");
    assert_eq!(result.get("error"), None, "{result:#}");
}

#[tokio::test]
async fn a_registered_null_is_reported_once_per_run() {
    let report = report(vec![
        json!({"type": "RUN_STARTED", "threadId": "t", "runId": "r", "rawEvent": null}),
        json!({"type": "TEXT_MESSAGE_START", "messageId": "m1", "rawEvent": null}),
        json!({"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "a", "rawEvent": null}),
        json!({"type": "TEXT_MESSAGE_END", "messageId": "m1", "rawEvent": null}),
        json!({"type": "RUN_FINISHED", "threadId": "t", "runId": "r", "result": null}),
    ])
    .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let warnings = warnings(&report);
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert!(warnings[0].contains("rawEvent"), "{warnings:?}");
    assert!(warnings[1].contains("result"), "{warnings:?}");
}

#[tokio::test]
async fn every_warning_is_a_warning_update_and_the_report_keeps_the_retention_limit() {
    let mut thread = thread(
        vec![
            json!({"type": "RUN_STARTED", "threadId": "t", "runId": "r", "a": 1, "b": 2, "c": 3}),
            finished(),
        ],
        1,
    );
    let mut run = thread.send("go").unwrap();
    assert_eq!(
        warning_updates(&mut run).await,
        [
            "unrecognised property at /a",
            "unrecognised property at /b",
            "unrecognised property at /c"
        ]
    );
    let report = run.collect_report().await;
    assert_eq!(report.diagnostics.len(), 1, "{:?}", report.diagnostics);
    assert_eq!(report.diagnostics[0].kind, "warning");
    assert_eq!(report.diagnostics[0].message, "unrecognised property at /a");
    assert_eq!(report.diagnostics_omitted, 2);
}

#[tokio::test]
async fn a_warning_repeated_through_a_run_is_delivered_once() {
    // A legacy producer streams reasoning one THINKING_* event per token.
    let mut events = vec![
        started(),
        json!({"type": "THINKING_START"}),
        json!({"type": "THINKING_TEXT_MESSAGE_START"}),
    ];
    events.extend((0..50).map(|token| {
        json!({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": format!("token {token} ")})
    }));
    events.extend([
        json!({"type": "THINKING_TEXT_MESSAGE_END"}),
        json!({"type": "THINKING_END"}),
        finished(),
    ]);
    let mut thread = thread(events, 100);
    let mut run = thread.send("go").unwrap();
    let delivered = warning_updates(&mut run).await;
    let distinct = [
        "translated retired THINKING_START to REASONING_START",
        "translated retired THINKING_TEXT_MESSAGE_START to REASONING_MESSAGE_START",
        "translated retired THINKING_TEXT_MESSAGE_CONTENT to REASONING_MESSAGE_CONTENT",
        "translated retired THINKING_TEXT_MESSAGE_END to REASONING_MESSAGE_END",
        "translated retired THINKING_END to REASONING_END",
    ];
    assert_eq!(delivered, distinct);
    let report = run.collect_report().await;
    assert_eq!(warnings(&report), distinct);
    assert_eq!(report.diagnostics.len(), distinct.len());
    assert_eq!(report.diagnostics_omitted, 0);
    assert_eq!(
        thread.reasoning().count(),
        1,
        "the reasoning itself is kept"
    );
}

#[tokio::test]
async fn the_callback_hears_a_repeated_warning_once_per_run() {
    let run = |id: &str| {
        let mut events = vec![json!({"type": "RUN_STARTED", "threadId": "t", "runId": id})];
        events.extend(
            (0..20).map(|_| json!({"type": "THINKING_TEXT_MESSAGE_CONTENT", "delta": "x"})),
        );
        events.extend((0..3).map(|_| json!({"type": "STEP_STARTED", "stepName": "s", "extra": 1})));
        events.push(json!({"type": "RUN_FINISHED", "threadId": "t", "runId": id}));
        events
    };
    // Two runs on one stream: each reports its own warnings.
    let raw = stream::iter(run("r1").into_iter().chain(run("r2")).map(Ok));
    let mut warnings = Vec::new();
    let events: Vec<_> = enforce_events(raw, |warning| warnings.push(warning))
        .collect()
        .await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let once = [
        "translated retired THINKING_TEXT_MESSAGE_CONTENT to REASONING_MESSAGE_CONTENT",
        "unrecognised property at /extra",
    ];
    assert_eq!(warnings, [once, once].concat());
}

#[tokio::test]
async fn standalone_decoding_hands_each_warning_to_a_callback_ahead_of_its_event() {
    let raw = stream::iter(
        [
            json!({"type": "RUN_STARTED", "threadId": "t", "runId": "r", "extra": 1}),
            json!({"type": "FUTURE_EVENT"}),
            finished(),
        ]
        .map(Ok),
    );
    let log = RefCell::new(Vec::new());
    let mut events = Box::pin(enforce_events(raw, |warning| {
        log.borrow_mut().push(warning)
    }));
    while let Some(event) = events.next().await {
        let tag = event.unwrap().event_type().as_str().to_owned();
        log.borrow_mut().push(tag);
    }
    drop(events);
    assert_eq!(
        log.into_inner(),
        [
            "unrecognised property at /extra",
            "RUN_STARTED",
            "unrecognised union member \"FUTURE_EVENT\" at /",
            "RUN_FINISHED"
        ]
    );
}

#[tokio::test]
async fn a_path_names_a_list_member_by_its_index_in_the_input() {
    // Two unknown operations are dropped ahead of a malformed known one; the
    // error still points at the third member the producer sent.
    let raw = stream::iter([Ok(json!({"type": "STATE_DELTA", "delta": [
        {"op": "frobnicate"}, {"op": "frobnicate"}, {"op": "add"}
    ]}))]);
    let mut warnings = Vec::new();
    let events: Vec<_> = enforce_events(raw, |warning| warnings.push(warning))
        .collect()
        .await;
    let [Err(error)] = events.as_slice() else {
        panic!("{events:?}");
    };
    assert!(error.to_string().contains("/delta/2 "), "{error}");
    assert_eq!(
        warnings,
        [
            "unrecognised union member \"frobnicate\" at /delta/0",
            "unrecognised union member \"frobnicate\" at /delta/1"
        ]
    );
}

#[tokio::test]
async fn a_warning_quotes_a_bounded_and_escaped_slice_of_the_input() {
    let long = "x".repeat(1 << 20);
    let mut event = started();
    event[&long] = json!(true);
    event["line\nbreak\u{1b}[31m"] = json!(true);
    let report = report(vec![event, finished()]).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let warnings = warnings(&report);
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    for warning in warnings {
        assert!(warning.len() < 256, "{} bytes", warning.len());
        assert!(!warning.contains(char::is_control), "{warning:?}");
    }
}
