//! The monorepo’s frozen AG-UI 1.0 schema fixtures, run as one table.
//!
//! `../../../../../spec/1.0/fixtures/<Definition>/{valid,invalid}/` holds
//! documents the 1.0 schema must accept or reject. Each one goes through the
//! boundary this SDK reads that definition with:
//!
//! - an event, through the client's compatibility boundary;
//! - a `RunAgentInput`, through the hosted endpoint's request decoder;
//! - a message, an interrupt, a file source, a tool or a resume entry, inside
//!   the smallest event or request that carries one;
//! - a capability document, through its type: nothing else reads one.
//!
//! A valid document arrives whole, without a warning. An invalid one is
//! rejected, unless [`TOLERATED`] names it with what happens instead: where
//! AG-UI 1.0 says unrecognised material survives, the boundary removes it and
//! says so, and it translates a retired shape.

#![cfg(all(feature = "client", feature = "sse", feature = "axum"))]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use ag_ui::axum::extract::decode_with_warnings;
use ag_ui::client::transport::{decode_raw_events, enforce_events};
use ag_ui::{AgentCapabilities, ExecutionCapabilities, MultiAgentCapabilities, SubagentInfo};
use futures_util::{FutureExt, StreamExt, stream};
use serde_json::{Value, json};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../../spec/1.0/fixtures")
}

/// Every `.json` under `dir`, as a path relative to it.
fn walk(dir: &Path, prefix: &str, out: &mut BTreeSet<String>) {
    for entry in std::fs::read_dir(dir).expect("the fixture directory") {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let path = format!("{prefix}{name}");
        if entry.file_type().unwrap().is_dir() {
            walk(&entry.path(), &format!("{path}/"), out);
        } else if name.ends_with(".json") {
            out.insert(path);
        }
    }
}

fn read(path: &str) -> Value {
    let text = std::fs::read_to_string(root().join(path)).expect("a listed fixture");
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{path} is not JSON: {error}"))
}

/// What became of a document.
#[derive(Debug, PartialEq)]
enum Fate {
    /// Delivered whole, with no warning.
    Whole,
    /// Delivered without the unrecognised material, with a warning.
    Stripped,
    /// A retired shape, delivered as its 1.0 replacement, with a warning.
    Translated,
    /// Removed from what carried it, or the carrier dropped, with a warning.
    Dropped,
    /// Read by a type that has no boundary: accepted, losing what the type
    /// does not hold.
    Lossy,
    Rejected(String),
}

/// `expected` is in `actual`: objects on the keys named, lists element by
/// element, everything else by equality.
fn within(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|actual| within(value, actual))),
        (Value::Array(expected), Value::Array(actual)) => {
            expected.len() == actual.len() && expected.iter().zip(actual).all(|(e, a)| within(e, a))
        }
        // The boundary writes an integral float as the integer it is.
        (Value::Number(expected), Value::Number(actual)) => expected.as_f64() == actual.as_f64(),
        _ => expected == actual,
    }
}

/// `document` as it arrived at `pointer` of what a boundary delivered.
fn fate(document: &Value, delivered: Option<Value>, pointer: &str, warnings: &[String]) -> Fate {
    let arrived = delivered.as_ref().and_then(|value| value.pointer(pointer));
    match arrived {
        None => {
            assert!(
                !warnings.is_empty(),
                "dropped without a warning: {document}"
            );
            Fate::Dropped
        }
        Some(arrived) if warnings.is_empty() => {
            assert!(
                within(document, arrived),
                "changed without a warning: {document} arrived as {arrived}"
            );
            Fate::Whole
        }
        Some(_)
            if warnings
                .iter()
                .any(|said| said.starts_with("translated retired")) =>
        {
            Fate::Translated
        }
        Some(_) => Fate::Stripped,
    }
}

/// An event through the client boundary; the document sits at `pointer`.
fn through_events(event: Value, document: &Value, pointer: &str) -> Fate {
    let frame = ag_ui::encode::sse::frame(&event.to_string());
    let raw = decode_raw_events(stream::iter([Ok::<_, std::io::Error>(frame.into_bytes())]));
    let mut warnings = Vec::new();
    let mut events = enforce_events(raw, |warning| warnings.push(warning))
        .collect::<Vec<_>>()
        .now_or_never()
        .expect("an in-memory stream is ready at once");
    match events.pop() {
        Some(Err(error)) => Fate::Rejected(error.to_string()),
        Some(Ok(event)) => {
            let delivered = serde_json::to_value(event).expect("events serialize");
            fate(document, Some(delivered), pointer, &warnings)
        }
        None => fate(document, None, pointer, &warnings),
    }
}

/// A request through the hosted endpoint's decoder.
fn through_input(input: Value, document: &Value, pointer: &str) -> Fate {
    match decode_with_warnings(input.to_string().as_bytes()) {
        Err(error) => Fate::Rejected(error.to_string()),
        Ok((input, warnings)) => {
            let delivered = serde_json::to_value(input).expect("the input serializes");
            fate(document, Some(delivered), pointer, &warnings)
        }
    }
}

/// A capability document through its type.
fn through_type<T: serde::de::DeserializeOwned + serde::Serialize>(document: &Value) -> Fate {
    match serde_json::from_value::<T>(document.clone()) {
        Err(error) => Fate::Rejected(error.to_string()),
        Ok(value) if within(document, &serde_json::to_value(&value).unwrap()) => Fate::Whole,
        Ok(_) => Fate::Lossy,
    }
}

fn run(definition: &str, document: Value) -> Fate {
    let input = |key: &str| {
        let mut input = json!({"threadId": "t", "runId": "r", "messages": []});
        input[key] = json!([document]);
        through_input(input, &document, &format!("/{key}/0"))
    };
    match definition {
        "RunAgentInput" => through_input(document.clone(), &document, ""),
        "Tool" => input("tools"),
        "ResumeEntry" => input("resume"),
        "UserMessage" | "ToolMessage" => through_events(
            json!({"type": "MESSAGES_SNAPSHOT", "messages": [document]}),
            &document,
            "/messages/0",
        ),
        "Interrupt" => through_events(
            json!({
                "type": "RUN_FINISHED", "threadId": "t", "runId": "r",
                "outcome": {"type": "interrupt", "interrupts": [document]},
            }),
            &document,
            "/outcome/interrupts/0",
        ),
        "FileSource" => through_events(
            json!({
                "type": "TOOL_CALL_RESULT", "messageId": "m", "toolCallId": "c",
                "content": [{"type": "document", "source": document}],
            }),
            &document,
            "/content/0/source",
        ),
        "AgentCapabilities" => through_type::<AgentCapabilities>(&document),
        "ExecutionCapabilities" => through_type::<ExecutionCapabilities>(&document),
        "MultiAgentCapabilities" => through_type::<MultiAgentCapabilities>(&document),
        "SubagentInfo" => through_type::<SubagentInfo>(&document),
        event if event.ends_with("Event") => through_events(document.clone(), &document, ""),
        other => panic!("no consumer is named for definition {other}: add it to `run`"),
    }
}

/// The invalid documents that are not rejected, and what happens instead.
/// AG-UI 1.0: unrecognised material is not an error, a malformed known value
/// is; and a registered optional `null` reads as the omitted field.
const TOLERATED: &[(&str, Fate)] = &[
    // An undescribed property on a closed object is stripped.
    ("FileSource/invalid/reference-record.json", Fate::Stripped),
    (
        "RunFinishedEvent/invalid/outcome-cancelled-carrying-interrupts.json",
        Fate::Stripped,
    ),
    (
        "RunFinishedEvent/invalid/outcome-interrupt-carrying-pending-tool-call-ids.json",
        Fate::Stripped,
    ),
    (
        "RunFinishedEvent/invalid/outcome-success-carrying-interrupts.json",
        Fate::Stripped,
    ),
    (
        "SubagentFinishedEvent/invalid/outcome-success-carrying-interrupt-ids.json",
        Fate::Stripped,
    ),
    (
        "TextMessageEndEvent/invalid/unknown-property.json",
        Fate::Stripped,
    ),
    // An unrecognised member of a union inside a list is dropped from the
    // list, which survives: a role, a content part, a patch operation.
    (
        "MessagesSnapshotEvent/invalid/role-shaped-like-a-tool-message.json",
        Fate::Stripped,
    ),
    (
        "MessagesSnapshotEvent/invalid/role-shaped-like-an-activity-message.json",
        Fate::Stripped,
    ),
    (
        "MessagesSnapshotEvent/invalid/role-shaped-like-an-assistant-message.json",
        Fate::Stripped,
    ),
    (
        "MessagesSnapshotEvent/invalid/unknown-role.json",
        Fate::Stripped,
    ),
    (
        "StateDeltaEvent/invalid/patch-unknown-op.json",
        Fate::Stripped,
    ),
    (
        "ToolCallResultEvent/invalid/content-part-unknown-type.json",
        Fate::Stripped,
    ),
    (
        "ToolMessage/invalid/content-part-unknown-type.json",
        Fate::Stripped,
    ),
    (
        "UserMessage/invalid/part-shaped-like-media-with-unknown-type.json",
        Fate::Stripped,
    ),
    (
        "UserMessage/invalid/part-shaped-like-text-with-unknown-type.json",
        Fate::Stripped,
    ),
    // The retired `binary` part is read as the media part it stands for.
    (
        "UserMessage/invalid/legacy-binary-part.json",
        Fate::Translated,
    ),
    // An unrecognised enum member in a required position takes the value
    // that holds it: the event, the resume entry.
    (
        "ReasoningEncryptedValueEvent/invalid/unknown-subtype.json",
        Fate::Dropped,
    ),
    ("ResumeEntry/invalid/unknown-status.json", Fate::Dropped),
    // The optional nulls the 1.0 deprecation registry lists read as omitted.
    ("RunFinishedEvent/invalid/outcome-null.json", Fate::Stripped),
    (
        "TextMessageContentEvent/invalid/subagent-run-id-null.json",
        Fate::Stripped,
    ),
    (
        "TextMessageEndEvent/invalid/raw-event-null.json",
        Fate::Stripped,
    ),
    (
        "ToolCallChunkEvent/invalid/parent-message-id-null.json",
        Fate::Stripped,
    ),
    (
        "ToolCallStartEvent/invalid/parent-message-id-null.json",
        Fate::Stripped,
    ),
    // Capability documents have no boundary. Their types skip a key they do
    // not know and read a null as absent ...
    ("AgentCapabilities/invalid/custom-null.json", Fate::Lossy),
    ("AgentCapabilities/invalid/metadata-null.json", Fate::Lossy),
    (
        "AgentCapabilities/invalid/old-subagents-key.json",
        Fate::Lossy,
    ),
    (
        "MultiAgentCapabilities/invalid/old-subagents-key.json",
        Fate::Lossy,
    ),
    // Some producers send a negative limit for "unlimited". The compatibility
    // reader omits it. Values above the safe-integer maximum are rejected.
    (
        "ExecutionCapabilities/invalid/negative-max-execution-time.json",
        Fate::Lossy,
    ),
];

#[test]
fn every_fixture_document_meets_the_fate_the_schema_gives_it() {
    let mut listed = BTreeSet::new();
    walk(&root(), "", &mut listed);
    let manifest: BTreeSet<String> = std::fs::read_to_string(root().join("MANIFEST.txt"))
        .expect("the schema fixture manifest")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect();
    assert_eq!(
        listed, manifest,
        "the schema fixtures must match MANIFEST.txt"
    );

    let mut failures = Vec::new();
    let mut tally = std::collections::BTreeMap::<String, usize>::new();
    let mut seen = BTreeSet::new();
    for path in listed.iter().filter(|path| !path.ends_with(".expect.json")) {
        let mut segments = path.split('/');
        let (definition, kind) = (segments.next().unwrap(), segments.next().unwrap());
        let fate = run(definition, read(path));
        let expected = match kind {
            "valid" => &Fate::Whole,
            "invalid" => {
                // Every rejected document says which rule rejected it.
                let expect = read(&path.replace(".json", ".expect.json"));
                assert!(
                    expect["keyword"].is_string(),
                    "{path}: no rejecting keyword"
                );
                match TOLERATED.iter().find(|row| row.0 == path) {
                    Some((_, tolerated)) => {
                        seen.insert(path.as_str());
                        tolerated
                    }
                    None => &Fate::Rejected(String::new()),
                }
            }
            other => panic!("{path}: {other} is neither valid nor invalid"),
        };
        let agrees = match (expected, &fate) {
            (Fate::Rejected(_), Fate::Rejected(_)) => true,
            (expected, fate) => expected == fate,
        };
        let label = match &fate {
            Fate::Rejected(_) => "rejected".to_owned(),
            other => format!("{other:?}").to_lowercase(),
        };
        *tally.entry(format!("{kind}: {label}")).or_default() += 1;
        if !agrees {
            failures.push(format!("{path}: {fate:?}, expected {expected:?}"));
        }
    }
    for (path, _) in TOLERATED {
        assert!(
            seen.contains(path),
            "TOLERATED names {path}, which is not an invalid fixture"
        );
    }
    println!("\n=== AG-UI 1.0 schema fixtures: {tally:?} ===");
    assert!(
        failures.is_empty(),
        "{} document(s) did not meet their fate:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
