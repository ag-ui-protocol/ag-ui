//! Subagents on the consuming side: the registry the applier keeps, the
//! attribution that reaches messages, the metadata that merges into them, and
//! what a thread reports.

#![cfg(feature = "client")]

use ag_ui::client::apply::{Applier, Changed, SubagentChange, SubagentChangeKind, SubagentStatus};
use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RunEnd, Thread, Update, verify_all};
use ag_ui::{
    Event, Interrupt, JsonObject, SubagentErrorEvent, SubagentFinishedEvent, SubagentOutcome,
    SubagentRunId, SubagentStartedEvent, TextMessageRole,
};
use futures_util::StreamExt;
use serde_json::json;

fn object(value: serde_json::Value) -> JsonObject {
    value.as_object().expect("an object literal").clone()
}

fn tagged(event: Event, id: &str) -> Event {
    event.with_subagent_run_id(id)
}

fn change(index: usize, id: &str, kind: SubagentChangeKind) -> Changed {
    Changed::Subagent(SubagentChange {
        index,
        run_id: SubagentRunId::new(id),
        kind,
    })
}

#[test]
fn lifecycle_events_build_the_registry() {
    let mut applier = Applier::new();
    applier.apply(&Event::run_started("t", "r")).unwrap();

    let started = applier
        .apply(&Event::SubagentStarted(
            SubagentStartedEvent::new("sub-1", "researcher")
                .with_description("Finds sources")
                .with_parent_tool_call("call-1")
                .with_parent_message("msg-0"),
        ))
        .unwrap();
    assert_eq!(started, change(0, "sub-1", SubagentChangeKind::Started));

    let nested = applier
        .apply(&Event::SubagentStarted(
            SubagentStartedEvent::new("sub-2", "reviewer").with_parent_subagent("sub-1"),
        ))
        .unwrap();
    assert_eq!(nested, change(1, "sub-2", SubagentChangeKind::Started));

    let first = applier.subagent(&"sub-1".into()).unwrap();
    assert_eq!(first.name, "researcher");
    assert_eq!(first.description.as_deref(), Some("Finds sources"));
    assert_eq!(first.parent_tool_call_id.as_deref(), Some("call-1"));
    assert_eq!(first.parent_message_id.as_deref(), Some("msg-0"));
    assert_eq!(first.status, SubagentStatus::Running);
    assert_eq!(
        applier.subagents()[1].parent_subagent_run_id.as_deref(),
        Some("sub-1")
    );

    let failed = applier
        .apply(&Event::SubagentError(
            SubagentErrorEvent::new("sub-2", "boom").with_code("500"),
        ))
        .unwrap();
    assert_eq!(failed, change(1, "sub-2", SubagentChangeKind::Failed));
    assert_eq!(
        applier.subagents()[1].status,
        SubagentStatus::Failed {
            message: "boom".into(),
            code: Some("500".into())
        }
    );

    let finished = applier
        .apply(&Event::SubagentFinished(
            SubagentFinishedEvent::new("sub-1")
                .with_result(json!({ "sources": 3 }))
                .with_outcome(SubagentOutcome::Success),
        ))
        .unwrap();
    assert_eq!(finished, change(0, "sub-1", SubagentChangeKind::Finished));
    assert_eq!(
        applier.subagents()[0].status,
        SubagentStatus::Finished {
            result: Some(json!({ "sources": 3 }))
        }
    );

    // A finish with no outcome reads as success, and one for an id nobody
    // announced still gets a row — tolerance is the applier's job.
    let legacy = applier.apply(&Event::subagent_finished("sub-9")).unwrap();
    assert_eq!(legacy, change(2, "sub-9", SubagentChangeKind::Finished));
    assert_eq!(applier.subagents()[2].name, "sub-9");
    assert_eq!(applier.subagents().len(), 3);
}

#[test]
fn a_suspended_subagent_announced_again_is_a_continuation() {
    let mut applier = Applier::new();
    applier.apply(&Event::run_started("t", "run-1")).unwrap();
    applier
        .apply(&Event::subagent_started("sub-1", "deleter"))
        .unwrap();

    let suspended = applier
        .apply(&Event::subagent_finished_suspended(
            "sub-1",
            vec!["int-1".to_owned()],
        ))
        .unwrap();
    assert_eq!(suspended, change(0, "sub-1", SubagentChangeKind::Suspended));
    assert_eq!(
        applier.subagents()[0].status,
        SubagentStatus::Suspended {
            result: None,
            interrupt_ids: vec!["int-1".into()]
        }
    );
    applier
        .apply(&Event::run_finished_interrupt(
            "t",
            "run-1",
            vec![Interrupt::new("int-1", "tool_approval").with_subagent_run_id("sub-1")],
        ))
        .unwrap();
    assert_eq!(
        applier.interrupts()[0].subagent_run_id.as_deref(),
        Some("sub-1")
    );

    // The resuming run announces the same id: waiting → running, one row.
    applier.apply(&Event::run_started("t", "run-2")).unwrap();
    let again = applier
        .apply(&Event::subagent_started("sub-1", "deleter"))
        .unwrap();
    assert_eq!(again, change(0, "sub-1", SubagentChangeKind::Resumed));
    assert_eq!(applier.subagents().len(), 1);
    assert_eq!(applier.subagents()[0].status, SubagentStatus::Running);
}

#[test]
fn attribution_transfers_to_the_messages_events_create() {
    let mut applier = Applier::new();
    for event in [
        Event::run_started("t", "r"),
        tagged(
            Event::text_message_start("m1", TextMessageRole::Assistant),
            "sub-1",
        ),
        tagged(Event::text_message_content("m1", "hi"), "sub-1"),
        tagged(Event::text_message_end("m1"), "sub-1"),
        // A parentless call opens a message of its own, which takes the tag.
        tagged(Event::tool_call_start("c1", "search"), "sub-1"),
        tagged(Event::tool_call_args("c1", "{}"), "sub-1"),
        tagged(Event::tool_call_end("c1"), "sub-1"),
        // Executed by the parent: the result's attribution is its own.
        Event::tool_call_result("m2", "c1", "ok"),
        tagged(
            Event::activity_snapshot("m3", "web_search", object(json!({ "q": 1 }))),
            "sub-1",
        ),
        tagged(Event::reasoning_message_start("r1"), "sub-1"),
        tagged(Event::reasoning_message_content("r1", "hm"), "sub-1"),
        tagged(Event::reasoning_message_end("r1"), "sub-1"),
        Event::text_message_start("m4", TextMessageRole::Assistant),
        Event::text_message_end("m4"),
        Event::run_finished_success("t", "r"),
    ] {
        applier.apply(&event).unwrap();
    }

    let owner = |id: &str| {
        applier
            .message(&id.into())
            .unwrap()
            .subagent_run_id()
            .map(SubagentRunId::as_str)
    };
    assert_eq!(owner("m1"), Some("sub-1"));
    assert_eq!(owner("c1-message"), Some("sub-1"));
    assert_eq!(owner("m2"), None);
    assert_eq!(owner("m3"), Some("sub-1"));
    assert_eq!(owner("m4"), None);
    assert_eq!(
        applier.reasoning()[0].subagent_run_id.as_deref(),
        Some("sub-1")
    );

    // A snapshot restates the activity, attribution included.
    applier
        .apply(&Event::activity_snapshot(
            "m3",
            "web_search",
            object(json!({ "q": 2 })),
        ))
        .unwrap();
    assert_eq!(
        applier.message(&"m3".into()).unwrap().subagent_run_id(),
        None
    );
}

#[test]
fn metadata_merges_into_what_each_event_builds() {
    let mut applier = Applier::new();
    let meta = |value: serde_json::Value| object(value);

    // RUN_STARTED builds no message, so its metadata reaches none.
    applier
        .apply(&Event::run_started("t", "r").with_metadata(meta(json!({ "trace": "run" }))))
        .unwrap();

    // Text: key by key, last write wins, values arrive when they are known.
    applier
        .apply(
            &Event::text_message_start("m1", TextMessageRole::Assistant)
                .with_metadata(meta(json!({ "source": "openai", "stage": "start" }))),
        )
        .unwrap();
    applier
        .apply(
            &Event::text_message_content("m1", "hi")
                .with_metadata(meta(json!({ "stage": "content" }))),
        )
        .unwrap();
    applier
        .apply(
            &Event::text_message_end("m1")
                .with_metadata(meta(json!({ "stage": "end", "usage": { "output": 340 } }))),
        )
        .unwrap();
    let message = applier.message(&"m1".into()).unwrap();
    assert_eq!(
        message.metadata(),
        Some(&meta(
            json!({ "source": "openai", "stage": "end", "usage": { "output": 340 } })
        ))
    );

    // Tool calls: into the call, not the message that carries it.
    applier
        .apply(&Event::tool_call_start("c1", "search").with_metadata(meta(json!({ "k": 1 }))))
        .unwrap();
    applier
        .apply(
            &Event::tool_call_args("c1", "{}")
                .with_metadata(meta(json!({ "k": 2, "extra": true }))),
        )
        .unwrap();
    applier.apply(&Event::tool_call_end("c1")).unwrap();
    let ag_ui::Message::Assistant(carrier) = applier.message(&"c1-message".into()).unwrap() else {
        panic!("the call opened an assistant message");
    };
    assert_eq!(carrier.metadata, None, "the carrying message is untouched");
    assert_eq!(
        carrier.tool_calls.as_ref().unwrap()[0].metadata,
        Some(meta(json!({ "k": 2, "extra": true })))
    );
    applier
        .apply(&Event::tool_call_result("m2", "c1", "ok").with_metadata(meta(json!({ "r": 1 }))))
        .unwrap();
    assert_eq!(
        applier.message(&"m2".into()).unwrap().metadata(),
        Some(&meta(json!({ "r": 1 })))
    );

    // Reasoning: the message, but not the block that wraps it.
    applier
        .apply(&Event::reasoning_start("r1").with_metadata(meta(json!({ "block": true }))))
        .unwrap();
    applier
        .apply(&Event::reasoning_message_start("r1").with_metadata(meta(json!({ "a": 1 }))))
        .unwrap();
    applier
        .apply(&Event::reasoning_message_content("r1", "hm").with_metadata(meta(json!({ "b": 2 }))))
        .unwrap();
    assert_eq!(
        applier.reasoning()[0].metadata,
        Some(meta(json!({ "a": 1, "b": 2 })))
    );

    // Activities: the activity message.
    applier
        .apply(
            &Event::activity_snapshot("m3", "web_search", object(json!({})))
                .with_metadata(meta(json!({ "act": 1 }))),
        )
        .unwrap();
    assert_eq!(
        applier.message(&"m3".into()).unwrap().metadata(),
        Some(&meta(json!({ "act": 1 })))
    );

    // Events that build nothing carry theirs without complaint.
    applier
        .apply(&Event::step_started("plan").with_metadata(meta(json!({ "s": 1 }))))
        .unwrap();
    applier
        .apply(&Event::state_snapshot(json!({})).with_metadata(meta(json!({ "s": 2 }))))
        .unwrap();
}

#[test]
fn a_chunk_without_an_id_continues_its_own_subagents_stream() {
    let mut applier = Applier::new();
    applier.apply(&Event::run_started("t", "r")).unwrap();
    for event in [
        tagged(
            Event::text_message_chunk(Some("m1".into()), Some("A ".into())),
            "s1",
        ),
        tagged(
            Event::text_message_chunk(Some("m2".into()), Some("B ".into())),
            "s2",
        ),
        tagged(Event::text_message_chunk(None, Some("one".into())), "s1"),
        tagged(Event::text_message_chunk(None, Some("two".into())), "s2"),
    ] {
        applier.apply(&event).unwrap();
    }
    assert_eq!(applier.text_of("m1"), Some("A one"));
    assert_eq!(applier.text_of("m2"), Some("B two"));

    // Two subagents' streams open and no parent's: nothing to resolve
    // against, so an untagged chunk is refused rather than guessed at.
    let error = applier
        .apply(&Event::text_message_chunk(None, Some("?".into())))
        .unwrap_err();
    assert!(error.to_string().contains("several"), "{error}");

    // The parent's own stream is what an untagged chunk continues.
    applier
        .apply(&Event::text_message_chunk(
            Some("m3".into()),
            Some("P ".into()),
        ))
        .unwrap();
    applier
        .apply(&Event::text_message_chunk(None, Some("arent".into())))
        .unwrap();
    assert_eq!(applier.text_of("m3"), Some("P arent"));
    assert_eq!(
        applier
            .message(&"m1".into())
            .unwrap()
            .subagent_run_id()
            .map(SubagentRunId::as_str),
        Some("s1")
    );
}

fn grouped_run() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::subagent_started("sub-1", "researcher"),
        tagged(
            Event::text_message_start("m1", TextMessageRole::Assistant),
            "sub-1",
        ),
        tagged(Event::text_message_content("m1", "Three sources."), "sub-1"),
        tagged(Event::text_message_end("m1"), "sub-1"),
        Event::SubagentFinished(
            SubagentFinishedEvent::new("sub-1")
                .with_result(json!({ "sources": 3 }))
                .with_outcome(SubagentOutcome::Success),
        ),
        Event::text_message_start("m2", TextMessageRole::Assistant),
        Event::text_message_content("m2", "Thanks."),
        Event::text_message_end("m2"),
        Event::run_finished_success("t", "r"),
    ]
}

#[test]
fn the_grouped_run_is_a_valid_stream() {
    verify_all(&grouped_run()).expect("a grouped run verifies");
}

#[tokio::test]
async fn a_thread_reports_the_lifecycle_and_the_messages_carry_their_owner() {
    let transport = ReplayTransport::new(grouped_run()).matching_requests();
    let mut thread = Thread::<_>::new(transport, "t");
    let mut lifecycle = Vec::new();
    let mut ended = None;

    let mut run = thread.send("research this").unwrap();
    while let Some(update) = run.next().await {
        match update {
            Update::Subagent(update) => {
                lifecycle.push((
                    update.run_id.as_str().to_owned(),
                    update.change,
                    update.subagent.status.clone(),
                ));
            }
            Update::Error(error) => panic!("{error}"),
            Update::Done(end) => ended = Some(end),
            _ => {}
        }
    }
    drop(run);

    assert!(matches!(ended, Some(RunEnd::Success { .. })));
    assert_eq!(
        lifecycle,
        [
            (
                "sub-1".to_owned(),
                SubagentChangeKind::Started,
                SubagentStatus::Running
            ),
            (
                "sub-1".to_owned(),
                SubagentChangeKind::Finished,
                SubagentStatus::Finished {
                    result: Some(json!({ "sources": 3 }))
                }
            ),
        ]
    );
    assert_eq!(thread.subagents().len(), 1);
    assert_eq!(thread.subagents()[0].name, "researcher");

    // The user's turn, the subagent's reply, the parent's reply.
    assert_eq!(thread.messages().len(), 3);
    assert_eq!(
        thread.messages()[1]
            .subagent_run_id()
            .map(SubagentRunId::as_str),
        Some("sub-1")
    );
    assert_eq!(thread.messages()[2].subagent_run_id(), None);
}

/// An activity snapshot with `replace` chosen — the factory's default is true.
fn activity(id: &str, content: ag_ui::JsonObject, replace: bool) -> Event {
    let mut event = ag_ui::ActivitySnapshotEvent::new(id, "progress", content);
    event.replace = replace;
    Event::ActivitySnapshot(event)
}

#[test]
fn a_merging_activity_snapshot_keeps_the_activitys_owner() {
    use ag_ui::JsonObject;

    let mut applier = Applier::new();
    applier
        .apply(&Event::run_started("t", "r"))
        .expect("applies");
    applier
        .apply(&activity("a1", JsonObject::new(), true).with_subagent_run_id("s1"))
        .expect("applies");

    let owner = |applier: &Applier| {
        applier
            .message(&"a1".into())
            .and_then(|message| message.subagent_run_id())
            .map(|id| id.as_str().to_owned())
    };
    assert_eq!(owner(&applier).as_deref(), Some("s1"));

    // `replace: false` merges content into the message where it is; only a
    // replacing snapshot re-mints it, attribution included.
    let mut step = JsonObject::new();
    step.insert("step".to_owned(), serde_json::json!(2));
    applier
        .apply(&activity("a1", step, false))
        .expect("applies");
    assert_eq!(owner(&applier).as_deref(), Some("s1"));
    applier
        .apply(&activity("a1", JsonObject::new(), true))
        .expect("applies");
    assert_eq!(owner(&applier), None);
}

/// A result that re-mints an existing tool message takes its attribution
/// with it, as both verifiers record the newest mint.
#[test]
fn a_second_result_for_the_same_message_re_mints_its_attribution() {
    let mut applier = Applier::new();
    applier
        .apply(&Event::run_started("t", "r"))
        .expect("applies");
    applier
        .apply(&Event::tool_call_start("c1", "search"))
        .expect("applies");
    applier.apply(&Event::tool_call_end("c1")).expect("applies");
    applier
        .apply(&Event::tool_call_result("m1", "c1", "theirs").with_subagent_run_id("s1"))
        .expect("applies");
    let owner = |applier: &Applier| {
        applier
            .message(&"m1".into())
            .and_then(|message| message.subagent_run_id())
            .map(|id| id.as_str().to_owned())
    };
    assert_eq!(owner(&applier).as_deref(), Some("s1"));

    applier
        .apply(&Event::tool_call_result("m1", "c1", "mine"))
        .expect("applies");
    assert_eq!(owner(&applier), None);
    assert_eq!(
        applier.message(&"m1".into()).map(|m| match m {
            ag_ui::Message::Tool(tool) => tool.content.clone(),
            _ => unreachable!(),
        }),
        Some("mine".to_owned())
    );
}
