//! What the events of an open item do once a `MESSAGES_SNAPSHOT` has replaced
//! what it was writing to, and what a tool call does whose parent cannot
//! carry it.
//!
//! AG-UI 1.0 lets a snapshot arrive anywhere in an open run
//! (`basic/patterns/streaming`: the standalone events "open and close no
//! items of their own, and MAY appear anywhere within an open run"), and
//! makes it the new baseline (`basic/patterns/snapshots`: "A consumer MUST
//! replace its copy with the snapshot's content — a snapshot is not a
//! merge"). An open item's later events apply to what the conversation then
//! holds under its id, and to nothing when it holds nothing: "The consumer's
//! duty is to return what it holds once all events have applied, not to
//! resurrect what a snapshot removed" (`events/reasoning`). Such an event is
//! dropped and the thread warns, once per item per run, as the reference
//! client warns and drops it. The verifier accepts every stream here, so
//! none of it fails the run.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RunEnd, RunReport, Thread, verify_all};
use ag_ui::{
    ActivityMessage, Event, JsonObject, Message, TextMessageRole, ToolCallStartEvent, ToolContent,
};
use serde_json::json;

fn call(id: &str, parent: &str) -> Event {
    ToolCallStartEvent::new(id, "search")
        .with_parent_message_id(parent)
        .into()
}

/// A thread that sent "go" and read `run` to its end, with the report.
async fn after(run: Vec<Event>) -> (Thread<ReplayTransport>, RunReport) {
    verify_all(&run).expect("the verifier accepts the stream");
    let transport = ReplayTransport::with_runs([run, success()]).matching_requests();
    let mut thread = Thread::new(transport, "t");
    let report = thread.send("go").unwrap().collect_report().await;
    (thread, report)
}

fn success() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
    ]
}

fn warnings(report: &RunReport) -> Vec<&str> {
    report
        .diagnostics
        .iter()
        .map(|diagnostic| {
            assert_eq!(diagnostic.kind, "warning", "{diagnostic:?}");
            diagnostic.message.as_str()
        })
        .collect()
}

fn ids(thread: &Thread<ReplayTransport>) -> Vec<&str> {
    thread
        .messages()
        .iter()
        .map(|message| message.id().as_str())
        .collect()
}

/// Before: the run failed, "protocol violation: TOOL_CALL_ARGS for unknown
/// tool call ToolCallId(\"c-1\")".
#[tokio::test]
async fn a_tool_call_a_snapshot_restated_its_message_without_is_dropped_with_a_warning() {
    let run = vec![
        Event::run_started("t", "r"),
        Event::text_message_start("a-1", TextMessageRole::Assistant),
        Event::text_message_content("a-1", "hi"),
        Event::text_message_end("a-1"),
        call("c-1", "a-1"),
        Event::tool_call_args("c-1", r#"{"q":"#),
        Event::messages_snapshot(vec![Message::assistant("a-1", "hi")]),
        Event::tool_call_args("c-1", "1}"),
        Event::tool_call_end("c-1"),
        Event::run_finished_success("t", "r"),
    ];
    let (mut thread, report) = after(run).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    // Said once for the call, at its first event with nowhere to go.
    assert_eq!(
        warnings(&report),
        [
            "TOOL_CALL_ARGS for tool call \"c-1\" was dropped: no message the thread holds has \
          that call"
        ]
    );
    // The snapshot's copy, and nothing made again from the rest of the call.
    assert_eq!(thread.messages(), [Message::assistant("a-1", "hi")]);
    assert!(thread.unanswered_tool_calls().is_empty());
    thread.send("next").expect("nothing is owed");
}

#[tokio::test]
async fn a_result_for_a_call_a_snapshot_dropped_leaves_a_thread_that_restores_and_goes_on() {
    let run = vec![
        Event::run_started("t", "r"),
        Event::text_message_start("a-1", TextMessageRole::Assistant),
        Event::text_message_content("a-1", "hi"),
        Event::text_message_end("a-1"),
        call("c-1", "a-1"),
        Event::tool_call_args("c-1", r#"{"q":"#),
        Event::messages_snapshot(vec![Message::assistant("a-1", "hi")]),
        Event::tool_call_args("c-1", "1}"),
        Event::tool_call_end("c-1"),
        Event::tool_call_result("t-1", "c-1", "found"),
        Event::run_finished_success("t", "r"),
    ];
    let (thread, report) = after(run).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    // The result is kept, as a result whose call the conversation no longer
    // holds; it answers nothing, and nothing is owed.
    assert_eq!(ids(&thread), ["a-1", "t-1"]);
    let Message::Tool(result) = &thread.messages()[1] else {
        panic!("{:?}", thread.messages());
    };
    assert_eq!(result.content, ToolContent::Text("found".into()));

    let transport = ReplayTransport::with_runs([success()]).matching_requests();
    let mut restored = Thread::<_>::restore(transport.clone(), thread.snapshot())
        .expect("what a run leaves restores");
    assert_eq!(restored.messages(), thread.messages());
    let report = restored.send("next").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(transport.last_request().unwrap().messages.len(), 3);
}

/// Before: the text after the snapshot opened a new message, an assistant
/// one, holding "two" only.
#[tokio::test]
async fn a_message_a_snapshot_dropped_while_open_stays_dropped() {
    let run = |snapshot: Vec<Message>| {
        vec![
            Event::run_started("t", "r"),
            Event::text_message_start("d-1", TextMessageRole::Developer),
            Event::text_message_content("d-1", "one "),
            Event::messages_snapshot(snapshot),
            Event::text_message_content("d-1", "two"),
            Event::text_message_end("d-1"),
            Event::run_finished_success("t", "r"),
        ]
    };

    let (thread, report) = after(run(Vec::new())).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert!(thread.messages().is_empty(), "{:?}", thread.messages());
    assert_eq!(
        warnings(&report),
        [
            "TEXT_MESSAGE_CONTENT for message \"d-1\" was dropped: the thread holds no message \
          with that id"
        ]
    );

    // Restated, the message takes what follows, on top of the snapshot's copy.
    let (thread, report) = after(run(vec![Message::developer("d-1", "one ")])).await;
    assert!(report.diagnostics.is_empty(), "{report:?}");
    assert_eq!(thread.messages(), [Message::developer("d-1", "one two")]);
}

#[tokio::test]
async fn reasoning_a_snapshot_dropped_while_open_stays_dropped() {
    let run = vec![
        Event::run_started("t", "r"),
        Event::reasoning_message_start("think-1"),
        Event::reasoning_message_content("think-1", "first"),
        // A snapshot that carries reasoning declares all of it.
        Event::messages_snapshot(vec![Message::Reasoning(ag_ui::ReasoningMessage {
            id: "think-0".into(),
            content: "earlier".into(),
            ..Default::default()
        })]),
        Event::reasoning_message_content("think-1", ", then"),
        Event::reasoning_message_end("think-1"),
        Event::run_finished_success("t", "r"),
    ];
    let (thread, report) = after(run).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(ids(&thread), ["think-0"]);
    assert_eq!(
        warnings(&report),
        [
            "REASONING_MESSAGE_CONTENT for reasoning message \"think-1\" was dropped: the thread \
          holds no message with that id"
        ]
    );
}

/// Before: "text streamed into activity message ..., which has no text"
/// failed the run.
#[tokio::test]
async fn text_for_an_id_an_activity_holds_is_dropped_with_a_warning() {
    let mut content = JsonObject::new();
    content.insert("percent".into(), json!(40));
    let run = vec![
        Event::run_started("t", "r"),
        Event::activity_snapshot("x-1", "progress", content.clone()),
        Event::text_message_start("x-1", TextMessageRole::Assistant),
        Event::text_message_content("x-1", "hello"),
        Event::text_message_end("x-1"),
        Event::run_finished_success("t", "r"),
    ];
    let (thread, report) = after(run).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let Some(Message::Activity(ActivityMessage { content: held, .. })) =
        thread.messages().iter().find(|m| m.id().as_str() == "x-1")
    else {
        panic!("{:?}", thread.messages());
    };
    assert_eq!(held, &content);
    assert_eq!(
        warnings(&report),
        [
            "TEXT_MESSAGE_START for message \"x-1\" was dropped: the thread holds an activity \
          message with that id, which takes no text"
        ]
    );
}

// ---- an id a reasoning message and a reply share --------------------------

/// Reasoning, then a reply under the same id, then a call that names the id
/// as its parent: the verifier keeps the two kinds apart and accepts it. The
/// reply continues the reasoning message, as the reference client has it,
/// so the call has no assistant message to sit in, and gets one of its own,
/// as a call with no parent does. Before: the call was recorded nowhere and
/// its arguments failed the run.
#[tokio::test]
async fn a_call_whose_parent_is_a_reasoning_message_sits_in_a_message_of_its_own() {
    let run = vec![
        Event::run_started("t", "r"),
        Event::reasoning_start("m-1"),
        Event::reasoning_message_start("m-1"),
        Event::reasoning_message_content("m-1", "thinking. "),
        Event::reasoning_message_end("m-1"),
        Event::reasoning_end("m-1"),
        Event::text_message_start("m-1", TextMessageRole::Assistant),
        Event::text_message_content("m-1", "The answer."),
        Event::text_message_end("m-1"),
        call("c-1", "m-1"),
        Event::tool_call_args("c-1", "{}"),
        Event::tool_call_end("c-1"),
        Event::run_finished_success("t", "r"),
    ];
    let (thread, report) = after(run).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(
        warnings(&report),
        [
            "TOOL_CALL_START for tool call \"c-1\" names parent message \"m-1\", which is a \
          reasoning message and carries no tool calls: the call is on message \"c-1-message\""
        ]
    );
    let held: Vec<_> = thread.messages().iter().skip(1).collect();
    let [Message::Reasoning(reasoning), Message::Assistant(carrier)] = held[..] else {
        panic!("{held:?}");
    };
    assert_eq!(reasoning.content, "thinking. The answer.");
    assert_eq!(carrier.id, "c-1-message");
    let calls = carrier.tool_calls.as_deref().unwrap_or_default();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].function.arguments, "{}");
    assert_eq!(thread.unanswered_tool_calls(), ["c-1"]);
}

/// Who the call's message belongs to is who the verifier says the call
/// belongs to: its tag; untagged, the owner the reply that shared the id
/// claimed it for, which is the parent agent here. A reply that lands on
/// another owner's reasoning says so.
#[tokio::test]
async fn an_id_shared_across_owners_is_said_and_the_call_is_whose_the_reply_is() {
    let s1 = |event: Event| event.with_subagent_run_id("s1");
    let run = |reply_owner: Option<&str>| {
        let reply = |event: Event| match reply_owner {
            Some(owner) => event.with_subagent_run_id(owner),
            None => event,
        };
        vec![
            Event::run_started("t", "r"),
            Event::subagent_started("s1", "thinker"),
            s1(Event::reasoning_message_start("m-1")),
            s1(Event::reasoning_message_content("m-1", "hm. ")),
            s1(Event::reasoning_message_end("m-1")),
            reply(Event::text_message_start("m-1", TextMessageRole::Assistant)),
            reply(Event::text_message_content("m-1", "Yes.")),
            reply(Event::text_message_end("m-1")),
            call("c-1", "m-1"),
            Event::tool_call_end("c-1"),
            Event::subagent_finished_success("s1"),
            Event::run_finished_success("t", "r"),
        ]
    };

    let (thread, report) = after(run(None)).await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(
        warnings(&report)[0],
        "TEXT_MESSAGE_START for message \"m-1\" is from the parent agent, and the thread holds \
         a reasoning message with that id from subagent \"s1\": the id is shared across owners, \
         and the text goes into that message"
    );
    let carrier = thread.applier().message(&"c-1-message".into()).unwrap();
    assert_eq!(carrier.subagent_run_id(), None);

    // The same owner: nothing to say about the id, and the call is theirs.
    let (thread, report) = after(run(Some("s1"))).await;
    assert_eq!(warnings(&report).len(), 1, "{report:?}");
    let carrier = thread.applier().message(&"c-1-message".into()).unwrap();
    assert_eq!(carrier.subagent_run_id().map(|id| id.as_str()), Some("s1"));
}

#[test]
fn a_parentless_tool_call_allocates_its_own_carrier_when_ids_collide() {
    let history = vec![
        Message::user("c-message", "question"),
        Message::assistant("c-message-1", "previous answer"),
    ];
    let mut applier = ag_ui::client::Applier::new().with_messages(history.clone());
    for event in [
        Event::tool_call_start("c", "search"),
        Event::tool_call_args("c", "{}"),
        Event::tool_call_end("c"),
    ] {
        applier.apply(&event).unwrap();
    }
    assert_eq!(&applier.messages()[..2], &history[..]);
    let Message::Assistant(carrier) = &applier.messages()[2] else {
        panic!("assistant carrier required")
    };
    assert_eq!(carrier.id, "c-message-2");
    assert_eq!(
        carrier.tool_calls.as_ref().unwrap()[0].function.arguments,
        "{}"
    );
}
