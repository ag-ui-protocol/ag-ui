//! State: snapshots, patches, and what happens when a patch does not apply.

#![cfg(feature = "client")]

use ag_ui::client::apply::{Applier, Changed};
use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{Error, MessageChangeKind, Thread, Update};
use ag_ui::{Event, PatchOperation};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;

#[test]
fn a_snapshot_replaces_the_state_and_a_delta_patches_it() {
    let mut applier = Applier::new();
    assert_eq!(applier.state(), &json!({}));

    let changed = applier
        .apply(&Event::state_snapshot(
            json!({ "items": ["a"], "count": 1 }),
        ))
        .expect("applies");
    assert_eq!(changed, Changed::State);

    applier
        .apply(&Event::state_delta(vec![
            PatchOperation::add("/items/-", json!("b")),
            PatchOperation::replace("/count", json!(2)),
            PatchOperation::add("/nested", json!({ "ok": true })),
        ]))
        .expect("applies");

    assert_eq!(
        applier.state(),
        &json!({ "items": ["a", "b"], "count": 2, "nested": { "ok": true } })
    );

    // A snapshot after a delta replaces everything, including keys the delta
    // added.
    applier
        .apply(&Event::state_snapshot(json!({ "count": 9 })))
        .expect("applies");
    assert_eq!(applier.state(), &json!({ "count": 9 }));
}

#[test]
fn a_patch_that_cannot_apply_is_an_error_and_changes_nothing() {
    let mut applier = Applier::new().with_state(json!({ "count": 1 }));

    let error = applier
        .apply(&Event::state_delta(vec![PatchOperation::replace(
            "/missing/deeply",
            json!(2),
        )]))
        .expect_err("replacing a path that does not exist must fail");

    assert!(
        matches!(&error, Error::Patch { target, .. } if target == "state"),
        "unexpected error: {error:?}"
    );
    assert!(error.to_string().contains("state patch failed"));
    // The state is exactly what it was: no half-applied patch.
    assert_eq!(applier.state(), &json!({ "count": 1 }));
}

#[test]
fn a_failed_operation_rolls_back_the_ones_before_it() {
    // RFC 6902 patches are all-or-nothing. The first operation here succeeds
    // and must still be undone when the second fails.
    let mut applier = Applier::new().with_state(json!({ "count": 1 }));

    applier
        .apply(&Event::state_delta(vec![
            PatchOperation::add("/added", json!(true)),
            PatchOperation::test("/count", json!(99)),
        ]))
        .expect_err("the test operation should fail");

    assert_eq!(applier.state(), &json!({ "count": 1 }));
}

#[test]
fn a_malformed_json_pointer_is_rejected_before_anything_is_mutated() {
    let mut applier = Applier::new().with_state(json!({ "count": 1 }));

    let error = applier
        .apply(&Event::state_delta(vec![PatchOperation::add(
            "not-a-pointer",
            json!(1),
        )]))
        .expect_err("a pointer must start with a slash");

    assert!(matches!(
        error,
        Error::InvalidPatchDocument { target, .. } if target == "state"
    ));
    assert_eq!(applier.state(), &json!({ "count": 1 }));
}

#[test]
fn a_delta_whose_value_the_producer_dropped_applies_as_null() {
    // `JSON.stringify` drops a key holding `undefined`, so a JavaScript agent
    // diffing state over such a key emits `{"op":"add","path":"/draft"}` with no
    // `value` at all. It has to arrive off the wire: building the operation in
    // Rust cannot reproduce the omission. Rejecting it took the whole
    // STATE_DELTA down, and in an SSE stream a failed event is a failed run.
    let event: Event = serde_json::from_str(
        r#"{"type":"STATE_DELTA","delta":[{"op":"add","path":"/draft"},{"op":"replace","path":"/count"}]}"#,
    )
    .expect("a producer's dropped value must not fail the event");

    let mut applier = Applier::new().with_state(json!({ "count": 1 }));
    applier.apply(&event).expect("applies");

    // Null, which is what the JavaScript patch libraries would have written —
    // not the key left untouched and not the key removed.
    assert_eq!(applier.state(), &json!({ "draft": null, "count": null }));
}

#[test]
fn an_activity_patch_that_cannot_apply_is_an_error_naming_the_activity() {
    let mut applier = Applier::new();
    let mut content = ag_ui::JsonObject::new();
    content.insert("status".into(), json!("running"));
    applier
        .apply(&Event::activity_snapshot("act-1", "web_search", content))
        .expect("applies");

    let error = applier
        .apply(&Event::activity_delta(
            "act-1",
            "web_search",
            vec![PatchOperation::replace("/nope", json!(1))],
        ))
        .expect_err("replacing a missing key must fail");

    assert!(
        matches!(&error, Error::Patch { target, .. } if target == "activity act-1"),
        "unexpected error: {error:?}"
    );

    // And the activity kept the content it had.
    let ag_ui::Message::Activity(activity) = &applier.messages()[0] else {
        panic!("expected an activity message");
    };
    assert_eq!(activity.content["status"], json!("running"));
}

#[test]
fn an_activity_patch_that_replaces_the_whole_document_is_refused() {
    // RFC 6902 lets an operation target the root, but an activity's content is
    // an object and a number cannot be one. Applying it used to succeed and
    // leave the activity holding `{}` — the content silently gone, with
    // `Ok(..)` returned and nothing to tell a view it had happened.
    let mut applier = Applier::new();
    let mut content = ag_ui::JsonObject::new();
    content.insert("percent".into(), json!(40));
    applier
        .apply(&Event::activity_snapshot("act-1", "progress", content))
        .expect("applies");

    let error = applier
        .apply(&Event::activity_delta(
            "act-1",
            "progress",
            vec![PatchOperation::replace("", json!("wiped"))],
        ))
        .expect_err("replacing the root with a string must fail");

    assert!(
        matches!(&error, Error::Patch { target, .. } if target == "activity act-1"),
        "unexpected error: {error:?}"
    );
    assert!(error.to_string().contains("a string"), "{error}");

    let ag_ui::Message::Activity(activity) = &applier.messages()[0] else {
        panic!("expected an activity message");
    };
    assert_eq!(
        activity.content["percent"],
        json!(40),
        "the activity must keep the content it had"
    );
}

#[test]
fn an_activity_patch_may_replace_the_whole_document_with_another_object() {
    // The other side of that check: targeting the root is legal RFC 6902 and
    // an object is a content an activity can hold, so this one lands. Refusing
    // every root-targeting operation would be the easy over-correction.
    let mut applier = Applier::new();
    let mut content = ag_ui::JsonObject::new();
    content.insert("percent".into(), json!(40));
    applier
        .apply(&Event::activity_snapshot("act-1", "progress", content))
        .expect("applies");

    applier
        .apply(&Event::activity_delta(
            "act-1",
            "progress",
            vec![PatchOperation::replace("", json!({ "percent": 100 }))],
        ))
        .expect("replacing the root with an object is fine");

    let ag_ui::Message::Activity(activity) = &applier.messages()[0] else {
        panic!("expected an activity message");
    };
    assert_eq!(activity.content["percent"], json!(100));
}

#[test]
fn an_activity_snapshot_can_merge_instead_of_replacing() {
    let mut applier = Applier::new();
    let mut first = ag_ui::JsonObject::new();
    first.insert("query".into(), json!("weather"));
    first.insert("hits".into(), json!(0));
    applier
        .apply(&Event::activity_snapshot("act-1", "web_search", first))
        .expect("applies");

    let mut second = ag_ui::JsonObject::new();
    second.insert("hits".into(), json!(3));
    applier
        .apply(&Event::ActivitySnapshot(ag_ui::ActivitySnapshotEvent {
            replace: false,
            ..ag_ui::ActivitySnapshotEvent::new("act-1", "web_search", second)
        }))
        .expect("applies");

    let ag_ui::Message::Activity(activity) = &applier.messages()[0] else {
        panic!("expected an activity message");
    };
    assert_eq!(activity.content["query"], json!("weather"));
    assert_eq!(activity.content["hits"], json!(3));
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
struct Counter {
    count: u32,
}

#[test]
fn the_state_can_be_read_as_a_caller_defined_type() {
    let mut applier = Applier::new();
    applier
        .apply(&Event::state_snapshot(json!({ "count": 3 })))
        .expect("applies");

    assert_eq!(
        applier.state_as::<Counter>().expect("deserializes"),
        Counter { count: 3 }
    );

    applier
        .apply(&Event::state_snapshot(json!({ "count": "three" })))
        .expect("applies");
    let error = applier
        .state_as::<Counter>()
        .expect_err("a string is not a u32");
    assert!(matches!(error, Error::State(_)), "unexpected: {error:?}");
    // The raw state is still exactly what the agent sent.
    assert_eq!(applier.state(), &json!({ "count": "three" }));
}

#[tokio::test]
async fn a_thread_reports_a_failed_patch_and_keeps_the_state_it_had() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::state_snapshot(json!({ "count": 1 })),
        Event::state_delta(vec![PatchOperation::replace("/missing/deeply", json!(2))]),
        Event::state_delta(vec![PatchOperation::replace("/count", json!(2))]),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("go").unwrap().collect().await;
    let errors: Vec<String> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect();

    assert_eq!(errors.len(), 1, "expected exactly one failure: {errors:?}");
    assert!(errors[0].contains("state patch failed"));

    // The run carried on, and the later delta still applied.
    assert_eq!(thread.raw_state(), &json!({ "count": 2 }));
    let states: Vec<_> = updates
        .iter()
        .filter(|update| matches!(update, Update::State(_)))
        .collect();
    assert_eq!(states.len(), 2);
}

/// An agent that does a tool's work while the call is open publishes state
/// between `TOOL_CALL_START` and `TOOL_CALL_END`. `STATE_*` is unordered, so
/// that is a well-formed stream and the client folds it like any other — the
/// update arrives while the call is still open, which is the point of sending
/// it there.
#[tokio::test]
async fn state_published_inside_an_open_tool_call_applies_like_any_other() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::state_snapshot(json!({ "count": 0 })),
        Event::tool_call_start("call-1", "increment"),
        Event::tool_call_args("call-1", r#"{"by":1}"#),
        Event::state_delta(vec![PatchOperation::replace("/count", json!(1))]),
        Event::tool_call_end("call-1"),
        Event::tool_call_result("msg-1", "call-1", r#"{"count":1}"#),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_, Counter>::builder(transport, "thread-1")
        .state(json!({"count": 0}))
        .build()
        .unwrap();

    let updates: Vec<_> = thread.send("increment").unwrap().collect().await;
    assert!(
        !updates
            .iter()
            .any(|update| matches!(update, Update::Error(_))),
        "the stream should apply cleanly: {updates:?}"
    );

    let order: Vec<&str> = updates
        .iter()
        .filter_map(|update| match update {
            Update::State(_) => Some("state"),
            Update::Message(message) => match message.change {
                MessageChangeKind::ToolCallArgs { .. } => Some("args"),
                MessageChangeKind::ToolCallEnded { .. } => Some("call ended"),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(order, ["state", "args", "state", "call ended"]);

    assert_eq!(thread.state().unwrap(), &Counter { count: 1 });
}

#[tokio::test]
async fn a_state_that_does_not_fit_the_typed_view_is_reported_without_losing_it() {
    // The agent publishes a partial state first. A strict type cannot hold it,
    // and saying so beats leaving the caller wondering why `state()` is `None`.
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::state_snapshot(json!({ "unrelated": true })),
        Event::state_snapshot(json!({ "count": 7 })),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_, Counter>::builder(transport, "thread-1")
        .state(json!({"count": 0}))
        .build()
        .unwrap();

    let updates: Vec<_> = thread.send("go").unwrap().collect().await;
    let errors: Vec<String> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect();

    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("does not match the expected type"));

    // The typed view caught up on the next snapshot, and the raw state was
    // never wrong.
    assert_eq!(thread.state().unwrap(), &Counter { count: 7 });
    assert_eq!(thread.raw_state(), &json!({ "count": 7 }));
}
